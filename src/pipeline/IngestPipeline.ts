// Phase 40 (PIPE-01): IngestPipeline — 4-stage orchestrator (extract → dedup
// → store → synthesize) composing the caller-pluggable Extractor +
// LayeredDeduplicator + caller-pluggable Synthesizer over a Phase 39
// GraphKMStore.
//
// SOURCE: lifted from OKM
//   _work/rapid-automations/integrations/operational-knowledge-management/
//   src/ingestion/pipeline.ts (lines 76-316 — the 4-stage main `ingest()`
//   flow + `onPhase` observability)
// with 10 deltas applied (per 40-RESEARCH Pitfall 7 + 40-CONTEXT D-42 / D-43
// / D-46 / CF-D30 + RESEARCH Q2 RESOLVED):
//
//   1. D-42 options-object ctor. Store is the only positional arg (primary
//      subject per CF-D14); extractor / deduplicator / synthesizer / onPhase
//      live on `IngestPipelineOpts`. OKM's 4-positional-arg ctor (`extractor,
//      deduplicator, graphStore, ontologyRegistry` at OKM pipeline.ts:82-92)
//      is REPLACED. No abstract base class; no `extends IngestPipeline`.
//
//   2. D-43 skipStages. `IngestOpts.skipStages?: StageName[]` is opt-out, not
//      reorder. Stage order is locked to extract → dedup → store → synthesize.
//      Per Pitfall 5 (RESEARCH offset 246-250), `skipStages: ['extract']`
//      with non-empty `text` THROWS — the cleaner public path for "run only
//      synthesize" is `runStage('synthesize', survivorIds, { provenance })`.
//
//   3. D-46 candidate-pool pre-load. Before each dedup call the pipeline
//      sources its candidate pool via
//      `findByOntologyClass(entity.ontologyClass ?? entity.entityType)`
//      — Phase 39 D-34's active-only-by-default filter is inherited (no
//      `includeSuperseded: true` passed, so superseded predecessors are
//      excluded). Layer impls do NOT re-filter.
//
//   4. CF-D30 provenance threading. `IngestOpts.provenance` is REQUIRED — the
//      pipeline NEVER invents a `ProvenanceStamp`; it threads the caller-
//      supplied stamp through to `store.putEntity({ provenance })` and
//      `synthesizer.synthesize({ provenance })` unchanged (same object
//      reference). The provenance-required guard fires up-front so callers
//      see the explicit error, not a downstream `putEntity` D-30 throw.
//
//   5. Phase 39 D-33 supersession via `putEntity({ ...entity, supersedes:
//      survivor.id }, { provenance })`. The store's `putEntity` closes the
//      predecessor's `validUntil` and writes the `SUPERSEDED_BY` edge
//      atomically (CR-01's per-op `skipOntologyCheck` handles legacy
//      non-v7 ids). The pipeline NEVER calls the raw batch op directly —
//      that's the Pitfall 2 anti-pattern.
//
//   6. Matched-survivors-only synthesizer-input contract (RESEARCH Example
//      5 line 646 verbatim — Warning #5 cleanup). The pipeline passes ONLY
//      the IDs of survivors that were MATCHED during dedup; net-new
//      (unmatched) entities are NOT forwarded to the synthesizer. The
//      synthesizer reads from the store for any additional context it
//      needs (PATTERNS offset 161: "Synthesizer receives entity IDs not
//      entities — synthesizer reads from store if needed").
//
//   7. RESEARCH Q2 RESOLVED `runStage` 4-overload form. `runStage` is
//      declared as 4 TypeScript function overloads — one per StageName —
//      plus a single implementation signature whose param types are the
//      union (`name: StageName`, etc.). NOT a generic `<T>` (which would
//      defeat the type-discoverability point). Per Q3 / A6, `runStage`
//      does NOT fire `onPhase` callbacks — that's exclusive to the
//      `ingest()` path.
//
//   8. 6 OKM-specific drops per Pitfall 7: `filterPII`, `capExtractionResult`,
//      `populateEvidenceMetadata`, `createDerivedFromEdges`,
//      `recordPatternOccurrences`, `handleMetricEntities`, `handleSupersession`
//      — none belong in km-core. PII + governance are deferred to Phase 43
//      caller-side per RESEARCH Q3.
//
//   9. 4 OKM split-mode entry-point drops: `extractOnly` /
//      `deduplicateAndStore` / `synthesizeAll` / `resolveEntities` (OKM
//      pipeline.ts:325-367) — km-core's equivalent is the single
//      `runStage()` method. `resolveEntities` is Phase 41 PIPE-02, not 40.
//
//  10. no-console-log. The 6 OKM `console.info`/`console.warn` calls
//      (pipeline.ts:119, 124, 159, 269, 282) are REMOVED. Observability
//      flows exclusively through the optional `onPhase` callback.
//      Catastrophic stderr-warns (e.g. extractor returning a non-array)
//      go through `process.stderr.write` with the `[km-core/pipeline]`
//      prefix — matches the broader Phase 37/38/39/40 stderr convention
//      (`src/segments/merge.ts:134-136`, `src/store/exporter.ts:112`).

import type { GraphKMStore } from '../store/GraphKMStore.js';
import type { Entity, ProvenanceStamp } from '../types/entity.js';
import type { EntityId } from '../ids/branded.js';
import type { LayeredDeduplicator } from '../dedup/LayeredDeduplicator.js';
import type { DedupResult } from '../dedup/types.js';
import type {
  Extractor,
  Synthesizer,
  PhaseCallback,
  IngestResult,
  IngestOpts,
  IngestPipelineOpts,
  StageName,
} from './types.js';

/**
 * 4-stage ingest orchestrator (PIPE-01). Composes an Extractor, a
 * {@link LayeredDeduplicator}, a GraphKMStore, and a caller-pluggable
 * Synthesizer into a single `ingest(text, opts)` call. The pipeline never
 * invents data: provenance is caller-supplied (CF-D30) and candidate pools
 * are sourced from the store (D-46).
 *
 * **Ctor contract (D-42 options-object).** The `store` is positional
 * (primary subject per CF-D14); all stage impls live on
 * {@link IngestPipelineOpts}. There is no abstract base — composition
 * happens by injection.
 *
 * **`ingest()` contract.** Runs the 4 stages strictly in order: extract →
 * dedup → store → synthesize. `IngestOpts.skipStages` may opt out of any
 * subset (D-43); `IngestOpts.provenance` is REQUIRED (CF-D30) and is
 * threaded unchanged to `store.putEntity({ provenance })` and
 * `synthesizer.synthesize({ provenance })`. Per-stage timing is recorded in
 * `IngestResult.durations` (ms, 0 when skipped); `IngestResult.skippedStages`
 * echoes back the `skipStages` array.
 *
 * **`runStage()` contract.** Declared as 4 TypeScript function overloads
 * (one per StageName) per RESEARCH Q2 RESOLVED — NOT a generic. Callers get
 * static type errors when they pass the wrong argument shape for a stage.
 * Does NOT fire `onPhase` callbacks (per RESEARCH Q3 + A6).
 *
 * Source: 40-RESEARCH Example 5 (offset 545-668); 40-CONTEXT D-42, D-43,
 * D-46, CF-D30; 40-PATTERNS offset 36-135.
 */
export class IngestPipeline {
  private store: GraphKMStore;
  private extractor: Extractor;
  private deduplicator: LayeredDeduplicator;
  private synthesizer: Synthesizer;
  private onPhase?: PhaseCallback;

  constructor(store: GraphKMStore, opts: IngestPipelineOpts) {
    this.store = store;
    this.extractor = opts.extractor;
    this.deduplicator = opts.deduplicator as LayeredDeduplicator;
    this.synthesizer = opts.synthesizer;
    this.onPhase = opts.onPhase;
  }

  /**
   * Run the 4-stage ingest pipeline over `text`. Returns
   * {@link IngestResult} with per-stage counts + durations.
   *
   * Guards:
   * - Throws when `opts.provenance` is missing (CF-D30 — pipeline never
   *   invents a stamp).
   * - Throws when `opts.skipStages` includes `'extract'` AND `text` is
   *   non-empty (Pitfall 5 — use `runStage('synthesize', ids, ...)` for
   *   off-pipeline stage invocation instead).
   */
  async ingest(text: string, opts: IngestOpts): Promise<IngestResult> {
    if (!opts || !opts.provenance) {
      throw new Error(
        'IngestPipeline.ingest requires opts.provenance (CF-D30 — pipeline does not invent provenance)',
      );
    }

    const skip = new Set<StageName>(opts.skipStages ?? []);

    if (skip.has('extract') && text && text.length > 0) {
      throw new Error(
        'skipStages: ["extract"] is only valid with empty text — use runStage() for off-pipeline stage invocation (Pitfall 5)',
      );
    }

    const durations: Record<string, number> = {};
    const result: IngestResult = {
      extractedCount: 0,
      mergedCount: 0,
      storedCount: 0,
      skippedCount: 0,
      droppedCount: 0,
      durations: { extractMs: 0, dedupMs: 0, storeMs: 0, synthesizeMs: 0 },
      skippedStages: Array.from(new Set(opts.skipStages ?? [])),
    };

    // Stage 1: extract.
    let entities: Entity[] = [];
    if (!skip.has('extract')) {
      this.onPhase?.({ stage: 'extract', status: 'start' });
      const t0 = Date.now();
      entities = await this.extractor.extract(text, opts.domain);
      durations.extractMs = Date.now() - t0;
      result.extractedCount = entities.length;
      this.onPhase?.({
        stage: 'extract',
        status: 'done',
        count: entities.length,
        durationMs: durations.extractMs,
      });
    }

    // Stage 2: dedup (per-entity, candidate pool scoped via D-46).
    const dedupDecisions: Array<{ entity: Entity; survivor?: Entity }> = [];
    if (!skip.has('dedup')) {
      this.onPhase?.({ stage: 'dedup', status: 'start' });
      const t0 = Date.now();
      for (const entity of entities) {
        const ontologyClass = entity.ontologyClass ?? entity.entityType;
        // CR-01 Pitfall-1 guard hoisted into the pipeline (mirrors
        // LayeredDeduplicator.ts:136-143). When BOTH ontologyClass and
        // entityType are falsy, findByOntologyClass would silently return []
        // and every input becomes net-new — a silent duplicate-write hazard.
        // Skip the dedup pre-load for this entity; net-new write at Stage 3
        // surfaces the missing-ontology via putEntity strict validation.
        if (!ontologyClass) {
          process.stderr.write(
            '[km-core/pipeline] entity ' +
              String(entity.id) +
              ' missing ontologyClass/entityType — skipping dedup\n',
          );
          dedupDecisions.push({ entity });
          continue;
        }
        // D-46 active-only candidate pool (Phase 39 D-34 default filter).
        const candidates = await this.store.findByOntologyClass(ontologyClass);
        const dedupResult: DedupResult = await this.deduplicator.dedup(
          entity,
          candidates,
        );
        dedupDecisions.push({
          entity,
          survivor: dedupResult.matched ? dedupResult.survivor : undefined,
        });
      }
      durations.dedupMs = Date.now() - t0;
      result.mergedCount = dedupDecisions.filter((d) => d.survivor).length;
      this.onPhase?.({
        stage: 'dedup',
        status: 'done',
        count: result.mergedCount,
        durationMs: durations.dedupMs,
      });
    } else {
      // Dedup skipped — every extracted entity flows through as net-new.
      for (const entity of entities) dedupDecisions.push({ entity });
    }

    // Stage 3: store (Phase 39 putEntity handles supersession atomically when
    // `supersedes` is set on the input entity — Phase 39 D-33 + CR-01).
    if (!skip.has('store')) {
      this.onPhase?.({ stage: 'store', status: 'start' });
      const t0 = Date.now();
      for (const { entity, survivor } of dedupDecisions) {
        if (survivor) {
          // Match → write new entity with supersedes pointing at survivor.
          // putEntity closes the predecessor's validUntil atomically.
          await this.store.putEntity(
            { ...entity, supersedes: survivor.id },
            { provenance: opts.provenance },
          );
        } else {
          // No match → net-new write.
          await this.store.putEntity(entity, { provenance: opts.provenance });
        }
        result.storedCount += 1;
      }
      durations.storeMs = Date.now() - t0;
      this.onPhase?.({
        stage: 'store',
        status: 'done',
        count: result.storedCount,
        durationMs: durations.storeMs,
      });
    }

    // Stage 4: synthesize (caller-pluggable — kept opaque to the pipeline).
    // Matched-survivors-only contract per RESEARCH Example 5 line 646 verbatim
    // (Warning #5 cleanup). The synthesizer reads from the store for any
    // additional context it needs (PATTERNS offset 161).
    if (!skip.has('synthesize')) {
      this.onPhase?.({ stage: 'synthesize', status: 'start' });
      const t0 = Date.now();
      const survivorIds = dedupDecisions.filter((d) => d.survivor).map((d) => d.survivor!.id);
      await this.synthesizer.synthesize(survivorIds, {
        provenance: opts.provenance,
      });
      durations.synthesizeMs = Date.now() - t0;
      this.onPhase?.({
        stage: 'synthesize',
        status: 'done',
        durationMs: durations.synthesizeMs,
      });
    }

    result.durations = {
      extractMs: durations.extractMs ?? 0,
      dedupMs: durations.dedupMs ?? 0,
      storeMs: durations.storeMs ?? 0,
      synthesizeMs: durations.synthesizeMs ?? 0,
    };
    return result;
  }

  // -- runStage: 4 typed function overloads (RESEARCH Q2 RESOLVED) --------
  //
  // Each overload pins the input/return types per stage name so callers get
  // static type errors when they pass the wrong argument shape. NOT a
  // generic `<T>` (would defeat the type-discoverability point per Q2).
  // Per Q3 + A6, runStage does NOT fire onPhase callbacks — the contract
  // is identical to invoking the underlying stage directly.

  /** Run only the extract stage. `provenance` is NOT needed (CR-04 fix); `opts.domain` threads through to extractor.extract. */
  runStage(name: 'extract', input: string, opts?: { domain?: string }): Promise<Entity[]>;
  /** Run only the dedup stage against a caller-supplied candidate pool. */
  runStage(name: 'dedup', input: Entity, opts: { candidates: Entity[] }): Promise<DedupResult>;
  /** Run only the store stage; `opts.supersedes` is an optional id→id map. */
  runStage(name: 'store', input: Entity[], opts: { provenance: ProvenanceStamp; supersedes?: Map<EntityId, EntityId> }): Promise<Entity[]>;
  /** Run only the synthesize stage over caller-supplied survivor ids. */
  runStage(name: 'synthesize', input: EntityId[], opts: { provenance: ProvenanceStamp }): Promise<void>;
  // Implementation signature (union of the overloads). The body switches on
  // `name`; each branch narrows `input` + `opts` via `as` casts that the
  // overloads have already verified are sound at the call site.
  async runStage(
    name: StageName,
    input: string | Entity | Entity[] | EntityId[],
    opts?: {
      provenance?: ProvenanceStamp;
      candidates?: Entity[];
      supersedes?: Map<EntityId, EntityId>;
      domain?: string;
    },
  ): Promise<Entity[] | DedupResult | void> {
    switch (name) {
      case 'extract': {
        return this.extractor.extract(input as string, opts?.domain);
      }
      case 'dedup': {
        if (!opts?.candidates) {
          throw new Error(
            "runStage('dedup') requires opts.candidates — pre-loaded ontologyClass-scoped pool per D-46",
          );
        }
        return this.deduplicator.dedup(input as Entity, opts.candidates);
      }
      case 'store': {
        if (!opts?.provenance) {
          throw new Error(
            "runStage('store') requires opts.provenance (CF-D30 — pipeline does not invent provenance)",
          );
        }
        const entities = input as Entity[];
        const stored: Entity[] = [];
        for (const entity of entities) {
          const supersedesId = opts.supersedes?.get(entity.id);
          if (supersedesId !== undefined) {
            await this.store.putEntity(
              { ...entity, supersedes: supersedesId },
              { provenance: opts.provenance },
            );
          } else {
            await this.store.putEntity(entity, { provenance: opts.provenance });
          }
          stored.push(entity);
        }
        return stored;
      }
      case 'synthesize': {
        if (!opts?.provenance) {
          throw new Error(
            "runStage('synthesize') requires opts.provenance (CF-D30 — pipeline does not invent provenance)",
          );
        }
        return this.synthesizer.synthesize(input as EntityId[], {
          provenance: opts.provenance,
        });
      }
      default: {
        // Unreachable: StageName is closed over the 4 cases above.
        const exhaustive: never = name;
        throw new Error(`runStage: unknown stage '${String(exhaustive)}'`);
      }
    }
  }
}

// Phase 40 (DEDUP-01): LayeredDeduplicator — 3-layer dedup orchestrator.
//
// SOURCE: lifted from OKM
//   _work/rapid-automations/integrations/operational-knowledge-management/
//   src/ingestion/deduplicator.ts (lines 53-322 — the 3-phase dedup
//   orchestrator)
// with 5 deltas applied:
//
//   1. D-44 typed layer slots replace OKM's single layer enum: the
//      orchestrator composes three TYPED layer slots (`ExactNameLayer`,
//      `EmbeddingLayer`, `LLMSemanticLayer`) per the locked layered-dedup
//      contract. Each slot ships its own per-layer threshold.
//
//   2. CF-D14 options-object ctor — callers inject layers via
//      `LayeredDeduplicatorOpts`, mirroring `GraphKMStore`'s ctor shape.
//      Layers are OPTIONAL: omitting a slot skips that layer cleanly.
//
//   3. D-44 `shortCircuit` opt (default `true`) replaces OKM's hard-coded
//      first-match-wins behavior. When `true` (production), the first
//      layer to report `matched && confidence >= threshold` short-circuits
//      the chain — downstream layers are NOT invoked. When `false`
//      (calibration / offline analysis), all layers run sequentially and
//      `allLayerResults` records every layer's verdict.
//
//   4. Pitfall 1 defensive guard (40-RESEARCH offset 210-214): if the
//      entity has neither `ontologyClass` nor `entityType`, no candidate
//      pool can be sourced (D-46 pre-load). Emit a stderr-warn and return
//      `{ matched: false, allLayerResults: [] }` so the entity falls
//      through to `putEntity` strict validation downstream.
//
//   5. shortCircuit:false winner policy is FIRST-MATCHED-WINS per
//      40-RESEARCH Example 1 line 323 (`layerResults.find((r) => r.matched)`).
//      Even if a later layer reports higher confidence, the first matched
//      layer in declared order is the winner. This keeps the
//      shortCircuit:false output consistent with shortCircuit:true (same
//      winner; only the audit trail differs).
//
// no-console-log: only the Pitfall 1 defensive guard emits diagnostics, via
// `process.stderr.write` — matches the broader Phase 37/38/39/40 stderr-warn
// convention (`src/segments/merge.ts:134-136`, `src/store/exporter.ts:112`).
// Per-layer logging stays inside each layer; orchestrator emits nothing on
// the happy path.

import type { Entity } from '../types/entity.js';
import type {
  ExactNameLayer,
  EmbeddingLayer,
  LLMSemanticLayer,
  DedupResult,
  MatchResult,
} from './types.js';

/**
 * Ctor opts for {@link LayeredDeduplicator} (D-44 + CF-D14 options-object
 * convention).
 *
 * All three layer slots are OPTIONAL. Callers compose a partial chain by
 * omitting slots — e.g. `{ exactName }` runs only the Jaccard layer. The
 * orchestrator iterates layers in declared cost-ascending order
 * (`exactName` → `embedding` → `llmSemantic`) and skips undefined slots.
 *
 * `shortCircuit` defaults to `true` — production behavior. Set to `false`
 * for calibration / offline analysis when callers need every layer's
 * verdict regardless of an earlier match.
 */
export interface LayeredDeduplicatorOpts {
  /** Layer 1 (cheapest). Jaccard name similarity per Plan 40-02. */
  exactName?: ExactNameLayer;
  /** Layer 2. Cosine embedding similarity per Plan 40-03. */
  embedding?: EmbeddingLayer;
  /** Layer 3 (most expensive). LLM semantic verdict per Plan 40-04. */
  llmSemantic?: LLMSemanticLayer;
  /**
   * When `true` (default per D-44), the first matched layer short-circuits
   * the chain. When `false`, every supplied layer runs and `allLayerResults`
   * carries the full audit trail.
   */
  shortCircuit?: boolean;
}

/**
 * Layered dedup orchestrator (D-44). Composes up to three layer slots and
 * applies the short-circuit-on-first-match contract.
 *
 * **D-44 contract.** The orchestrator iterates layers in declared
 * cost-ascending order (`exactName` cheapest → `embedding` → `llmSemantic`
 * most expensive). A layer "matches" when its `match()` returns
 * `matched: true` AND `confidence >= layer.threshold`. When
 * `shortCircuit: true` (default), the first matching layer wins and
 * downstream layers are NOT called. When `shortCircuit: false`, all
 * supplied layers run; the FIRST matched layer (in declared order) wins —
 * `layerResults.find((r) => r.matched)` per 40-RESEARCH Example 1 line 323.
 *
 * **D-46 candidate pre-load.** Callers (i.e. `IngestPipeline`) source the
 * `candidates` pool via `store.findByOntologyClass(entity.ontologyClass)`
 * BEFORE invoking `dedup()`. The orchestrator does NOT re-filter.
 *
 * **Pitfall 1 defensive guard.** If the input entity has neither
 * `ontologyClass` nor `entityType`, no candidate pool can be sourced;
 * `dedup()` emits a `[km-core/dedup]` stderr-warn and returns
 * `{ matched: false, allLayerResults: [] }` so the entity falls through to
 * `putEntity` strict validation downstream (which is the correct place to
 * surface the missing-ontology error per 40-RESEARCH line 213).
 *
 * Source: 40-RESEARCH Example 1 lines 275-328; 40-CONTEXT D-44, D-46;
 * 40-PATTERNS offset 198-263.
 */
export class LayeredDeduplicator {
  private exactName?: ExactNameLayer;
  private embedding?: EmbeddingLayer;
  private llmSemantic?: LLMSemanticLayer;
  private shortCircuit: boolean;

  constructor(opts: LayeredDeduplicatorOpts) {
    this.exactName = opts.exactName;
    this.embedding = opts.embedding;
    this.llmSemantic = opts.llmSemantic;
    this.shortCircuit = opts.shortCircuit ?? true;
  }

  /**
   * Run the configured layer chain against `candidates` and return the
   * aggregated dedup verdict (D-44). See class JSDoc for the
   * short-circuit + first-matched-wins contract.
   *
   * Pitfall 1: when `entity.ontologyClass` AND `entity.entityType` are
   * both absent, returns `{ matched: false, allLayerResults: [] }` after a
   * `[km-core/dedup]` stderr-warn — no layer is invoked.
   */
  async dedup(entity: Entity, candidates: Entity[]): Promise<DedupResult> {
    // Pitfall 1 defensive guard (40-RESEARCH offset 210-214). An entity
    // without ontologyClass AND without entityType cannot have its
    // candidate pool pre-loaded via D-46 store.findByOntologyClass(). Emit
    // a soft monitoring warning and let the entity fall through to
    // putEntity strict validation downstream.
    if (!entity.ontologyClass && !entity.entityType) {
      process.stderr.write(
        '[km-core/dedup] entity ' +
          String(entity.id) +
          ' has no ontologyClass/entityType — skipping dedup\n',
      );
      return { matched: false, allLayerResults: [] };
    }

    // Declared cost-ascending order: cheapest first. `as const` narrows
    // the `name` field to the literal union, so it lines up with
    // `DedupResult.matchedLayer`'s 'exactName' | 'embedding' | 'llmSemantic'
    // discriminator without a cast.
    const layers = [
      { name: 'exactName', layer: this.exactName },
      { name: 'embedding', layer: this.embedding },
      { name: 'llmSemantic', layer: this.llmSemantic },
    ] as const;

    const layerResults: Array<{
      layer: string;
      matched: boolean;
      survivor?: Entity;
      confidence: number;
    }> = [];

    for (const { name, layer } of layers) {
      if (!layer) continue;
      const result: MatchResult = await layer.match(entity, candidates);
      layerResults.push({ layer: name, ...result });
      if (this.shortCircuit && result.matched && result.confidence >= layer.threshold) {
        // Short-circuit: first qualifying layer wins; downstream skipped.
        return {
          matched: true,
          survivor: result.survivor!,
          matchedLayer: name,
          confidence: result.confidence,
          allLayerResults: layerResults,
        };
      }
    }

    // No short-circuit (or shortCircuit:false aggregation path). The
    // FIRST matched layer in declared order wins — see Delta #5 in the
    // file header. This is the locked policy per 40-RESEARCH Example 1
    // line 323.
    const winner = layerResults.find((r) => r.matched);
    return winner
      ? {
          matched: true,
          survivor: winner.survivor!,
          matchedLayer: winner.layer as 'exactName' | 'embedding' | 'llmSemantic',
          confidence: winner.confidence,
          allLayerResults: layerResults,
        }
      : { matched: false, allLayerResults: layerResults };
  }
}

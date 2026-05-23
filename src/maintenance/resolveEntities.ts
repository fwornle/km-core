// Phase 41 Plan 06 (PIPE-02): `resolveEntities` post-hoc cross-batch
// duplicate resolver — the user-facing library function that ties Plans
// 01 (ontology) + 03 (getDegree) + 05 (mergeEntities) together into one
// callable surface.
//
// Algorithm (ported from OKM deduplicator.ts:620-720 with KM-Core deltas):
//
//   1. Resolve target classes:
//        - If `opts.classes` is provided, use verbatim.
//        - Else default to all subclasses of `LearningArtifact` resolved
//          via `store.ontology` registry — `registry.getAllClassNames()
//          .filter(c => registry.parentChainOf(c).some(rc => rc.name ===
//          'LearningArtifact'))`. CRITICAL: `parentChainOf` returns
//          `ResolvedClass[]` (objects with `.name`), NOT `string[]` —
//          matching via `.includes('LearningArtifact')` would always be
//          false (object !== string) and silently produce an empty
//          subclass list. See Plan 01 SUMMARY + registry.ts:220-230.
//   2. Per-class iteration in waves of `concurrency` classes via
//      Promise.allSettled (default concurrency=3, OKM line 651-654).
//   3. Per class, fetch active entities via `store.findByOntologyClass(cls)`
//      (Phase 39 D-34 default includeSuperseded:false; we never re-merge
//      already-superseded history).
//   4. Build entity summaries with 200-char description truncation
//      (OKM line 666 — load-bearing for prompt size).
//   5. Per batch of `batchSize` (default 30) summaries: for each entity in
//      the batch, call `opts.llmMatcher.match(subject, candidates_excluding_self)`
//      with the batch-minus-self as candidates. O(batch²) per batch
//      (T-41-06-04 accepted).
//   6. When `result.matched && result.confidence >= threshold` and a
//      target entity can be identified (km-core's MatchResult exposes
//      `survivor?: Entity` directly — see src/dedup/types.ts:46-53):
//        a. Verify the surfaced survivor is in the candidate pool. Defensive
//           name+description reverse lookup catches LLM hallucinations
//           where the matcher returns a survivor not in the candidate
//           pool. Unmatchable case → push to errors[] and skip (NEVER
//           merge an entity that lacks a deterministic id mapping).
//        b. Tie-break on collisions: when multiple candidates share the
//           same name+description, pick the LOWEST lexicographic id
//           (`localeCompare` on id strings). Single match → sort is a
//           no-op. Multiple matches → deterministic across runs.
//        c. Pick survivor by degree: `await store.getDegree(...)` for
//           both; higher wins; tie → subject wins (matches OKM line
//           712 `degreeA >= degreeB ? [entityA, ...] : [entityB, ...]`,
//           where `entityA` is the subject).
//        d. If `opts.dryRun: true`: append plan to merges[] but skip
//           the mergeEntities call. matchedAway is NOT updated (nothing
//           was merged).
//        e. Else: invoke `mergeEntities(store, survivor.id, [dup.id], opts.provenance)`.
//           On success: matchedAway.add(dup.id). On throw: catch into
//           errors[] (do NOT bubble — let scan continue).
//   7. Final result: `runId = opts.provenance.runId`; `durationMs =
//      Date.now() - startTs`.
//
// KM-Core deltas from OKM:
//   - Top-level free function, not a class method (CF-D36).
//   - Caller-supplied LLMSemanticLayer (Plan 40 DEDUP-01), NOT a custom
//     batchLLMResolution. The matcher does its own 5-stage JSON unwrap +
//     error handling.
//   - `store.findByOntologyClass` per class (active-only default per
//     CF-D34) replaces OKM's `store.getAllEntities()` (km-core has no
//     getAllEntities — see 41-PATTERNS Cross-Cutting Notes).
//   - `store.getDegree(id)` (Plan 03) replaces OKM's
//     `graphStore.getDegree(layerId)` — no `layer:` prefix scheme in
//     km-core (Phase 37 D-08).
//   - Default-class resolution via registry.parentChainOf-by-.name
//     (Plan 01 SUMMARY pins this; Plan 06 PLAN <interfaces> documents the
//     ResolvedClass[]-vs-string[] gotcha).
//   - The 'unmatchable' error path defends against LLM hallucinations
//     that return survivors not in the candidate pool. The plan body
//     describes this in terms of an OKM-style `matchedTo: { name,
//     description }` reverse lookup; km-core's MatchResult exposes
//     `survivor?: Entity` directly. The defensive lookup is implemented
//     by filtering candidates by name+description equality even when
//     survivor.id is present — this catches the case where the matcher
//     returns a survivor entity whose name+description does not actually
//     match anything in the live candidate pool (e.g. legacy survivor
//     attached to a now-superseded entity, or matcher bug).
//
// no-console-log: all diagnostics via `process.stderr.write` with the
// `[km-core/maintenance]` prefix (matches Plan 05 mergeEntities.ts:362).

import type { Entity, ProvenanceStamp } from '../types/entity.js';
import type { EntityId } from '../ids/branded.js';
import type { GraphKMStore } from '../store/GraphKMStore.js';
import type { LLMSemanticLayer, MatchResult } from '../dedup/types.js';
import { mergeEntities } from './mergeEntities.js';

/**
 * Progress event emitted via `opts.log?(event)` when supplied.
 *
 * `phase` discriminator:
 *   - `'startClass'` — scan begins for a class; `ontologyClass` +
 *     `entitiesScanned` populated.
 *   - `'batchDone'` — per-batch progress within a class; `ontologyClass`
 *     + `matchesFound` populated.
 *   - `'classDone'` — class scan complete; `ontologyClass` +
 *     `matchesFound` populated.
 *   - `'match'` — a surfaced match passes threshold + reverse-lookup +
 *     tie-break; populates `merge.{survivorId,duplicateId}` (the survivor
 *     side is selected by `getDegree` AFTER this event fires).
 *   - `'merge'` — merge executed (not fired in dryRun mode); populates
 *     `merge.{survivorId,duplicateId}`.
 *   - `'error'` — per-batch LLM failure or unmatchable matchedTo or
 *     mergeEntities failure caught; populates `error`.
 */
export interface ResolveEvent {
  phase:
    | 'startClass'
    | 'batchDone'
    | 'classDone'
    | 'match'
    | 'merge'
    | 'error';
  ontologyClass?: string;
  entitiesScanned?: number;
  matchesFound?: number;
  merge?: { survivorId: EntityId; duplicateId: EntityId };
  error?: string;
}

/**
 * Options bag for `resolveEntities` (CF-D14 options-object signature).
 */
export interface ResolveOptions {
  /**
   * Caller-supplied LLMSemanticLayer (typically a Phase 40
   * `LLMSemanticMatcher` instance). The matcher is responsible for its
   * own client + parse-error handling per the layer contract.
   */
  llmMatcher: LLMSemanticLayer;
  /**
   * ProvenanceStamp identifying the resolve run. Threaded into every
   * underlying `mergeEntities` invocation. `provenance.runId` is also
   * returned in `ResolveResult.runId` (single source of truth).
   */
  provenance: ProvenanceStamp;
  /**
   * Explicit class list. When omitted, defaults to all subclasses of
   * `LearningArtifact` resolved via `store.ontology` registry — throws
   * if `store.ontology === undefined`. See Plan 01 SUMMARY for the
   * canonical extends-chain shape.
   */
  classes?: string[];
  /**
   * When `true`, plan the merges but do NOT execute them. Returns the
   * planned `merges[]` array with the same shape as a non-dryRun run.
   * Default `false`.
   */
  dryRun?: boolean;
  /** Max classes processed concurrently per wave. Default `3` (OKM line 651). */
  concurrency?: number;
  /** Max entities per LLM batch within a class. Default `30` (OKM line 654). */
  batchSize?: number;
  /**
   * Per-match confidence threshold; matches with `confidence < threshold`
   * are skipped. Default `0.70` (Plan 40 LLMSemanticMatcher default).
   */
  threshold?: number;
  /** Optional progress callback. Swallowed if it throws. */
  log?: (e: ResolveEvent) => void;
}

/**
 * Result returned by `resolveEntities`.
 */
export interface ResolveResult {
  /** Echo of `opts.provenance.runId` — single source of truth across the run. */
  runId: string;
  /**
   * Per-merge plan rows. When `dryRun: true`, these are the PLANNED
   * merges (nothing executed). When `dryRun: false`, these are the
   * EXECUTED merges (or merges that would have been executed; merge
   * failures land in `errors[]` while leaving the plan row in `merges[]`).
   */
  merges: Array<{
    survivorId: EntityId;
    survivorName: string;
    duplicateId: EntityId;
    duplicateName: string;
    ontologyClass: string;
    confidence: number;
  }>;
  /**
   * Accumulator for non-fatal errors. Per-batch LLM failures, unmatchable
   * MatchResult survivors (LLM hallucinations not in candidate pool), and
   * mergeEntities failures all land here. The scan continues regardless
   * — `resolveEntities` NEVER bubbles a per-entity error out of the
   * function body.
   */
  errors: string[];
  /** Echo of `opts.dryRun` — false if undefined. */
  dryRun: boolean;
  /** Class names actually scanned (post default-resolution). */
  classesScanned: string[];
  /** Wall-clock duration in ms (entry to return). */
  durationMs: number;
}

/**
 * Default concurrency for class waves (OKM `deduplicator.ts:651` —
 * `RESOLUTION_CONCURRENCY=3`).
 */
const DEFAULT_CONCURRENCY = 3;

/**
 * Default batch size within a class (OKM `deduplicator.ts:654` —
 * `BATCH_SIZE=30` reduced from 50 b/c descriptions inflate prompt size).
 */
const DEFAULT_BATCH_SIZE = 30;

/**
 * Default confidence threshold (matches Plan 40 LLMSemanticMatcher
 * default `0.70`).
 */
const DEFAULT_THRESHOLD = 0.7;

/**
 * Description truncation length for entity summaries (OKM line 666 —
 * load-bearing for prompt size; longer descriptions inflate token
 * budget unproductively).
 */
const SUMMARY_DESCRIPTION_TRUNCATION = 200;

/** Internal per-entity summary shape passed to the matcher batches. */
interface EntitySummary {
  id: EntityId;
  name: string;
  description: string;
  entity: Entity;
}

/**
 * Best-effort invocation of `opts.log?` — never bubbles a logger error.
 */
function safeLog(opts: ResolveOptions, evt: ResolveEvent): void {
  if (opts.log === undefined) return;
  try {
    opts.log(evt);
  } catch {
    // Swallow logger errors; never block scan progress.
  }
}

/**
 * Resolve `opts.classes` (verbatim) or compute the default subclass-set
 * from `store.ontology` via the parentChainOf-by-.name walk.
 *
 * CRITICAL: `parentChainOf` returns `ResolvedClass[]` (objects with
 * `.name`, `.source`, `.extends`, …) — NOT `string[]`. The filter
 * `.some(rc => rc.name === 'LearningArtifact')` is correct;
 * `.includes('LearningArtifact')` would always be false (object !==
 * string) and produce an empty subclass list → silent SC#3/SC#4
 * failure. This is the Plan 06 revision-1 B1 fix.
 *
 * @throws if `opts.classes` is omitted and `store.ontology === undefined`.
 */
function resolveTargetClasses(
  store: GraphKMStore,
  opts: ResolveOptions,
): string[] {
  if (opts.classes !== undefined) return [...opts.classes];

  const registry = store.ontology;
  if (registry === undefined) {
    throw new Error(
      "resolveEntities: opts.classes omitted but store has no ontology registry. " +
        "Construct the store with the bundled km-core ontology via " +
        "`new GraphKMStore({ ..., ontologyDir: defaultOntologyDir() })` " +
        "(both exported from '@fwornle/km-core'), or pass an explicit " +
        '`classes: ["Observation", "Digest", "Insight"]` to resolveEntities.',
    );
  }

  // Walk the registry: a class is a LearningArtifact subclass iff its
  // parentChain (an array of ResolvedClass objects, NOT strings) contains
  // at least one whose `.name === 'LearningArtifact'`. parentChainOf does
  // NOT include the class itself; since Observation/Digest/Insight each
  // declare `extends: 'LearningArtifact'` (Plan 01), the chain starts
  // with LearningArtifact for each — the filter matches correctly.
  // 'LearningArtifact' itself is NOT in the result (its parent chain is
  // empty). This is intentional — we scan the leaves, not the abstract.
  const subclasses = registry
    .getAllClassNames()
    .filter((c) =>
      registry.parentChainOf(c).some(rc => rc.name === 'LearningArtifact'),
    );
  return subclasses;
}

/**
 * Map a MatchResult onto a concrete candidate EntityId.
 *
 * km-core's `MatchResult.survivor` is a full `Entity` (with `.id`), unlike
 * OKM's `MatchResult.matchedTo` which exposes only `{ name, description }`.
 * The Plan 06 contract specifies the OKM-style `matchedTo.name` +
 * `matchedTo.description` reverse-lookup; this implementation honors the
 * SAME defensive contract by deriving the name+description identity tuple
 * from `survivor.name` + `survivor.description` (i.e. `result.matchedTo.name`
 * in the plan's notation maps to `survivor.name` here, and
 * `result.matchedTo.description` maps to `survivor.description`).
 *
 * Defensive lookup catches:
 *   - LLM hallucinations where the matcher returns a survivor not actually
 *     in the live candidate pool (e.g. a matcher bug or stale-survivor
 *     scenario) — unmatchable; pushed to errors[] and skipped.
 *   - Name+description collisions across distinct entities — deterministic
 *     tie-break via `id.localeCompare` (lowest lex-id wins).
 *
 * Equivalent of OKM-style filter (plan body §<interfaces>):
 *   const matches = candidates.filter(
 *     c => c.name === result.matchedTo.name &&
 *          c.description === result.matchedTo.description,
 *   );
 *
 * Returns `{ ok: true, target }` or `{ ok: false, error }`.
 */
function lookupSurvivorInCandidatePool(
  matchResult: MatchResult,
  candidates: EntitySummary[],
  subjectId: EntityId,
  ontologyClass: string,
): { ok: true; target: EntitySummary } | { ok: false; error: string } {
  const survivor = matchResult.survivor;
  if (survivor === undefined) {
    return {
      ok: false,
      error: `unmatchable: matched=true but survivor undefined for class ${ontologyClass}`,
    };
  }
  // Build a reverse-lookup keyed by name+description (the OKM-style
  // matchedTo contract). Exclude the subject itself by id — same logical
  // entity is not a duplicate of itself.
  const matches = candidates.filter(
    (c) =>
      c.id !== subjectId &&
      c.name === survivor.name &&
      c.description === survivor.description,
  );
  if (matches.length === 0) {
    // LLM hallucinated a name+description not in candidate pool, OR the
    // matcher returned a survivor that doesn't share name+description
    // with any active candidate. Either way: unmatchable.
    return {
      ok: false,
      error: `unmatchable: LLM returned matchedTo name="${survivor.name}" not in candidate pool for class ${ontologyClass}`,
    };
  }
  // Tie-break: when multiple candidates share name+description, pick
  // the LOWEST lexicographic id (deterministic across runs). Single
  // match → sort is a no-op.
  const target = matches
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  return { ok: true, target };
}

/**
 * Process a single ontology class — wraps the per-class batch loop +
 * surfaces matches + invokes `mergeEntities` per surfaced match.
 *
 * Each surfaced match contributes one row to `merges[]` (regardless of
 * dryRun); errors land in `errors[]`. Skips already-matched-away
 * duplicates via the per-class `matchedAway` set.
 */
async function processClass(
  store: GraphKMStore,
  ontologyClass: string,
  opts: ResolveOptions,
  threshold: number,
  batchSize: number,
  merges: ResolveResult['merges'],
  errors: string[],
): Promise<void> {
  const entities = await store.findByOntologyClass(ontologyClass);
  process.stderr.write(
    `[km-core/maintenance] resolveEntities: scanning class ${ontologyClass} ${String(entities.length)} entities\n`,
  );
  safeLog(opts, {
    phase: 'startClass',
    ontologyClass,
    entitiesScanned: entities.length,
  });

  if (entities.length < 2) {
    safeLog(opts, {
      phase: 'classDone',
      ontologyClass,
      matchesFound: 0,
    });
    return;
  }

  const summaries: EntitySummary[] = entities.map((e) => ({
    id: e.id,
    name: e.name,
    // 200-char truncation per OKM line 666 — load-bearing for prompt size.
    description: (e.description ?? '').slice(0, 200),
    entity: e,
  }));

  const matchedAway = new Set<EntityId>();
  let matchesFoundInClass = 0;

  for (
    let batchStart = 0;
    batchStart < summaries.length;
    batchStart += batchSize
  ) {
    const batch = summaries.slice(batchStart, batchStart + batchSize);
    if (batch.length < 2) continue;

    for (const subject of batch) {
      if (matchedAway.has(subject.id)) continue;

      // Candidates: rest of the batch (exclude self by id). NB: filter by
      // id, not by name — names may collide within a batch.
      const candidates = batch.filter(
        (c) => c.id !== subject.id && !matchedAway.has(c.id),
      );
      if (candidates.length === 0) continue;

      // Per-entity LLM call — collect the MatchResult.
      let result: MatchResult;
      try {
        result = await opts.llmMatcher.match(
          subject.entity,
          candidates.map((c) => c.entity),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const errMsg = `LLM resolution error for class ${ontologyClass} entity ${String(subject.id)}: ${msg}`;
        errors.push(errMsg);
        process.stderr.write(
          `[km-core/maintenance] ${errMsg}\n`,
        );
        safeLog(opts, { phase: 'error', ontologyClass, error: errMsg });
        continue;
      }

      // Filter by threshold first; the matcher MAY return matched:true
      // with a confidence below opts.threshold (LLMSemanticMatcher's
      // own threshold is layer-internal; we apply opts.threshold as a
      // resolveEntities-level gate).
      if (!result.matched || result.confidence < threshold) continue;

      // Reverse-lookup the survivor into the candidate pool. Defensive
      // against LLM hallucinations (survivor not in pool) and
      // name+description collisions (deterministic tie-break).
      const lookup = lookupSurvivorInCandidatePool(
        result,
        batch,
        subject.id,
        ontologyClass,
      );
      if (!lookup.ok) {
        errors.push(lookup.error);
        process.stderr.write(
          `[km-core/maintenance] ${lookup.error}\n`,
        );
        safeLog(opts, {
          phase: 'error',
          ontologyClass,
          error: lookup.error,
        });
        continue;
      }
      const target = lookup.target;

      // Skip if either endpoint was already merged in this class.
      if (matchedAway.has(target.id) || matchedAway.has(subject.id)) continue;

      // Pick survivor by degree (OKM line 711-719). Higher degree wins;
      // tie → subject wins (matches OKM `degreeA >= degreeB`).
      const [degSubject, degTarget] = await Promise.all([
        store.getDegree(subject.id),
        store.getDegree(target.id),
      ]);
      const [survivor, duplicate] =
        degSubject >= degTarget
          ? [subject, target]
          : [target, subject];

      const mergeRow = {
        survivorId: survivor.id,
        survivorName: survivor.name,
        duplicateId: duplicate.id,
        duplicateName: duplicate.name,
        ontologyClass,
        confidence: result.confidence,
      };
      merges.push(mergeRow);
      matchesFoundInClass += 1;
      safeLog(opts, {
        phase: 'match',
        ontologyClass,
        merge: {
          survivorId: survivor.id,
          duplicateId: duplicate.id,
        },
      });

      if (opts.dryRun === true) {
        // Plan-only path: do NOT invoke mergeEntities. matchedAway is
        // intentionally NOT updated (nothing was executed; a second
        // dryRun pass would surface the same plan).
        continue;
      }

      // Live merge — invoke Plan 05's mergeEntities primitive. Failures
      // bubble into errors[]; the scan continues to the next pair.
      try {
        await mergeEntities(store, survivor.id, [duplicate.id], {
          provenance: opts.provenance,
          reason: `resolveEntities ${ontologyClass} confidence=${String(result.confidence)}`,
        });
        matchedAway.add(duplicate.id);
        process.stderr.write(
          `[km-core/maintenance] merging duplicate ${String(duplicate.id)} into survivor ${String(survivor.id)} (confidence ${String(result.confidence)})\n`,
        );
        safeLog(opts, {
          phase: 'merge',
          ontologyClass,
          merge: {
            survivorId: survivor.id,
            duplicateId: duplicate.id,
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const errMsg = `mergeEntities failed for ${String(survivor.id)} <- ${String(duplicate.id)}: ${msg}`;
        errors.push(errMsg);
        process.stderr.write(
          `[km-core/maintenance] ${errMsg}\n`,
        );
        safeLog(opts, { phase: 'error', ontologyClass, error: errMsg });
      }
    }

    safeLog(opts, {
      phase: 'batchDone',
      ontologyClass,
      matchesFound: matchesFoundInClass,
    });
  }

  safeLog(opts, {
    phase: 'classDone',
    ontologyClass,
    matchesFound: matchesFoundInClass,
  });
}

/**
 * Post-hoc cross-batch duplicate resolver — scans a graph by ontology
 * class, uses a caller-supplied `LLMSemanticLayer` to surface candidate
 * duplicate pairs, picks the higher-degree node as survivor, and atomically
 * merges via Plan 05's `mergeEntities` primitive. The whole Phase 41
 * deliverable (PIPE-02 SC#3 + SC#4) is reachable through this one function.
 *
 * Class resolution:
 *   - `opts.classes` provided → used verbatim.
 *   - `opts.classes` omitted → defaults to all subclasses of
 *     `LearningArtifact` resolved via `store.ontology` (Plan 01 / Phase 38
 *     registry). Throws if the store lacks an ontology registry.
 *
 * Per surfaced match:
 *   - When `result.matched && result.confidence >= opts.threshold`, the
 *     survivor returned by the matcher is mapped back to a concrete
 *     EntityId via a name+description reverse lookup against the live
 *     candidate pool. LLM hallucinations (survivor not in pool) land in
 *     `result.errors[]`; deterministic tie-break (`localeCompare` on id)
 *     handles name+description collisions across distinct entities.
 *   - Survivor is the higher-degree node (OKM line 711-719); ties → subject
 *     wins.
 *   - `mergeEntities` is invoked with `{ provenance, reason }`.
 *
 * `dryRun: true` returns the planned `merges[]` (same shape) without
 * invoking `mergeEntities`. Identical merges are produced on a re-run
 * against the same data — the resolver is deterministic given a
 * deterministic matcher.
 *
 * Per-batch LLM failures are caught into `errors[]`; mergeEntities
 * failures are likewise caught (the scan continues to the next match).
 * The function NEVER bubbles a per-entity error out of its body.
 *
 * Concurrency: `Promise.allSettled` waves of `opts.concurrency` classes
 * (default 3). Within a class, per-entity matcher calls are serial
 * (O(batch²) per batch — see T-41-06-04).
 *
 * @example
 * ```ts
 * const result = await resolveEntities(store, {
 *   llmMatcher: new LLMSemanticMatcher({ client: groqClient }),
 *   provenance: { provider: 'maintenance', model: 'phase-41', runId, timestamp },
 *   classes: ['Observation'],
 *   dryRun: false,
 * });
 * // result.merges: Array<{ survivorId, duplicateId, ontologyClass, confidence, ... }>
 * ```
 */
export async function resolveEntities(
  store: GraphKMStore,
  opts: ResolveOptions,
): Promise<ResolveResult> {
  const startTs = Date.now();
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const dryRun = opts.dryRun === true;

  const merges: ResolveResult['merges'] = [];
  const errors: string[] = [];

  // --- Resolve target classes (default = LearningArtifact subclasses) ---
  const classes = resolveTargetClasses(store, opts);

  if (classes.length === 0) {
    process.stderr.write(
      '[km-core/maintenance] resolveEntities: no LearningArtifact subclasses registered; nothing to scan\n',
    );
    return {
      runId: opts.provenance.runId,
      merges,
      errors,
      dryRun,
      classesScanned: [],
      durationMs: Date.now() - startTs,
    };
  }

  // --- Concurrency waves of `concurrency` classes via Promise.allSettled ---
  for (let i = 0; i < classes.length; i += concurrency) {
    const wave = classes.slice(i, i + concurrency);
    await Promise.allSettled(
      wave.map((cls) =>
        processClass(
          store,
          cls,
          opts,
          threshold,
          batchSize,
          merges,
          errors,
        ),
      ),
    );
  }

  process.stderr.write(
    `[km-core/maintenance] resolveEntities: scanned ${String(classes.length)} classes, ${String(merges.length)} merges, ${String(errors.length)} errors, durationMs=${String(Date.now() - startTs)}\n`,
  );

  return {
    runId: opts.provenance.runId,
    merges,
    errors,
    dryRun,
    classesScanned: classes,
    durationMs: Date.now() - startTs,
  };
}

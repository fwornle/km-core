// Pipeline-API public types (D-42 IngestPipelineOpts, D-43 IngestOpts + StageName,
// PhaseCallback + IngestResult ported from OKM pipeline.ts:28-68).
//
// All shapes are net-new to KM-Core. The shapes follow CONTEXT decisions
// D-42 (options-object ctor), D-43 (skipStages opt + StageName enum), D-46
// (class-scoped candidate pool — pipeline sources candidates via
// store.findByOntologyClass), CF-D30 (caller-supplied ProvenanceStamp
// threaded through all 4 stages), plus the carry-forward CF-D14 options-
// object convention.
//
// SOURCE: lifted from OKM
//   _work/rapid-automations/integrations/operational-knowledge-management/
//   src/ingestion/pipeline.ts (lines 28-68 — IngestionContext,
//   IngestionResult, PhaseCallback)
// with 4 deltas applied:
//
//   1. D-42 options-object ctor replaces OKM's 4-positional-arg constructor
//      (extractor / deduplicator / synthesizer / onPhase live on
//      IngestPipelineOpts instead).
//
//   2. D-43 skipStages added to IngestOpts; StageName is the enumerated
//      union of the four canonical stage names.
//
//   3. PhaseCallback gains an optional `count?: number` field (per
//      40-CONTEXT specifics line 139) on top of OKM's verbatim
//      { stage, status, durationMs? } shape — so dedup/store stages can
//      report their per-batch population at `status: 'done'`.
//
//   4. IngestResult drops OKM's caller-specific fields (`entityIds`,
//      `errors`, `orphanNodeIds`, `confirmedCount` — see 40-RESEARCH Q2 #9
//      dropdown list) and ADDS `skippedStages`, `skippedCount`,
//      `droppedCount`, and the explicit `durations.{extract,dedup,store,
//      synthesize}Ms` breakdown.
//
// Plan-05 / 06a will implement the IngestPipeline class itself; this file
// only locks the public type surface so layer ports (Plans 02/03/04) and
// orchestrator tests can compile-bind against it without scavenger-hunt
// dependencies.
//
// Forward-reference note (Rule 3 deviation — see 40-01-SUMMARY.md):
// The plan-author-prescribed `import type { LayeredDeduplicator } from
// '../dedup/LayeredDeduplicator.js'` would TS2307 at Plan 40-01 time
// (that class file is created in Plan 40-05). Resolved by declaring an
// inline structural `Deduplicator` interface here — what the pipeline
// actually needs from the deduplicator slot. Plan 40-05's
// `LayeredDeduplicator` class will then `implements Deduplicator`.

import type { Entity, ProvenanceStamp } from '../types/entity.js';
import type { EntityId } from '../ids/branded.js';
import type { DedupResult } from '../dedup/types.js';

/**
 * Enumerated stage-name discriminator for the 4-stage ingest framework.
 * Per D-43, callers may opt out of any stage via IngestOpts.skipStages.
 * Stage order is part of the framework's contract per ROADMAP SC#3:
 * `extract → dedup → store → synthesize`.
 *
 * Source: 40-RESEARCH Example 5 line 562; 40-CONTEXT D-43.
 */
export type StageName = 'extract' | 'dedup' | 'store' | 'synthesize';

/**
 * Caller-pluggable extractor stage. Systems ship their own concrete impl
 * (A's daily-digest extractor, B's wave extractor, OKM's EntityExtractor).
 *
 * The pipeline passes `domain` through verbatim if the caller provides it
 * on `IngestOpts.domain`; otherwise undefined. Mirrors OKM's
 * `EntityExtractor` interface (`src/ingestion/extractor.ts`).
 *
 * Source: 40-CONTEXT D-42 ("Extractor / synthesizer interfaces — callers
 * ship the concrete impls per system").
 */
export interface Extractor {
  /** Returns the entities extracted from `text` for the given `domain`. */
  extract(text: string, domain?: string): Promise<Entity[]>;
}

/**
 * Caller-pluggable synthesizer stage. Receives the IDs of survivor
 * entities (those that either were net-new or that survived a dedup merge)
 * so the synthesizer can read fresh entity state from the store if it
 * needs to. Source: 40-RESEARCH Example 5 line 647; 40-CONTEXT D-42.
 *
 * Note: takes `EntityId[]`, NOT `Entity[]` — the synthesizer reads from
 * the store if it needs the full payloads, so the pipeline never has to
 * carry pre-store snapshots across the store-stage boundary.
 *
 * `provenance` is threaded through per CF-D30 (writer-side stamping); the
 * synthesizer forwards it to any store writes it makes.
 */
export interface Synthesizer {
  /** Run the synthesize stage over `survivorIds`. */
  synthesize(
    survivorIds: EntityId[],
    opts: { provenance: ProvenanceStamp },
  ): Promise<void>;
}

/**
 * Structural deduplicator contract — what `IngestPipeline` requires from
 * the `deduplicator` slot of `IngestPipelineOpts`. Plan 40-05's
 * `LayeredDeduplicator` class is the canonical implementor; Plan 40-01
 * declares the interface inline so this types module compiles standalone
 * at Plan 01 time (Rule 3 deviation — avoids a forward-reference import
 * of a not-yet-created class file).
 *
 * Source: 40-RESEARCH Example 1 line 305 (the dedup method signature);
 * 40-CONTEXT D-44 (layer composition).
 */
export interface Deduplicator {
  /** Run all layers (per LayeredDeduplicator's ctor) against `candidates`. */
  dedup(entity: Entity, candidates: Entity[]): Promise<DedupResult>;
}

/**
 * Pipeline observability hook (CF-D30 + D-42). Fires `status: 'start'`
 * before each stage runs and `status: 'done'` after — with optional
 * `count` (size of the population the stage processed) and `durationMs`
 * (wall-clock for the stage).
 *
 * Port shape from OKM `pipeline.ts:64-68` (verbatim), with `count?: number`
 * added per 40-CONTEXT specifics line 139.
 */
export type PhaseCallback = (e: {
  stage: StageName;
  status: 'start' | 'done';
  count?: number;
  durationMs?: number;
}) => void;

/**
 * Constructor options for `IngestPipeline` (D-42 options-object).
 *
 * - `extractor`, `deduplicator`, `synthesizer` are REQUIRED — the pipeline
 *   refuses to construct without all three. Systems that skip stages do so
 *   via `IngestOpts.skipStages` at `ingest()` time, not by omitting these
 *   slots.
 * - `onPhase?` is the observability hook; pipelines may opt out by
 *   omitting it.
 *
 * Source: 40-RESEARCH Example 5 lines 555-560; 40-CONTEXT D-42.
 */
export interface IngestPipelineOpts {
  /** Caller-pluggable extractor (Stage 1). */
  extractor: Extractor;
  /** Layered deduplicator (Stage 2 driver) — `LayeredDeduplicator` in Plan 40-05. */
  deduplicator: Deduplicator;
  /** Caller-pluggable synthesizer (Stage 4). */
  synthesizer: Synthesizer;
  /** Optional observability hook; fires per-stage start + done. */
  onPhase?: PhaseCallback;
}

/**
 * Per-call options for `IngestPipeline.ingest()` (D-43 + CF-D30).
 *
 * - `provenance` is REQUIRED per CF-D30 — the pipeline never invents a
 *   ProvenanceStamp; it threads the caller-supplied stamp through all four
 *   stages and forwards it to `store.putEntity({ provenance })` in the
 *   store stage.
 * - `skipStages?` opts out of any subset of the four stages (typically
 *   `['synthesize']` for A's daily-cron path). Stage order is fixed; this
 *   is opt-out, not reorder.
 * - `domain?` is passed verbatim to the extractor (`extractor.extract(text,
 *   domain)`); semantics are extractor-specific.
 *
 * Source: 40-RESEARCH Example 5 lines 564-568; 40-CONTEXT D-43, CF-D30.
 */
export interface IngestOpts {
  /** REQUIRED per CF-D30. The store stage forwards this to putEntity. */
  provenance: ProvenanceStamp;
  /** Per D-43: opt-out subset of the four stages. Stage order is fixed. */
  skipStages?: StageName[];
  /** Passed verbatim to `extractor.extract(text, domain)`. */
  domain?: string;
}

/**
 * Return shape of `IngestPipeline.ingest()`.
 *
 * Population counts:
 * - `extractedCount` — entities returned by the extractor.
 * - `mergedCount` — count of dedup decisions that matched (i.e. those
 *   entities will be stored with `supersedes` pointing at a survivor).
 * - `storedCount` — entities the store stage actually wrote (matches
 *   `extractedCount` when no stages are skipped).
 * - `skippedCount` — entities the framework dropped without writing
 *   (caller-policy decisions; pipeline-internal use, default 0).
 * - `droppedCount` — entities removed by an extractor-side cap / PII
 *   filter (pipeline-internal use; v0.1 forwards 0 — PII is deferred to
 *   Phase 43 caller-side per 40-RESEARCH Q3).
 *
 * Durations are wall-clock per stage; 0 when the stage was skipped.
 *
 * `skippedStages` echoes back exactly the `IngestOpts.skipStages` array
 * the caller passed in (canonicalized via `Array.from(new Set(...))`) so
 * callers can assert which stages actually ran.
 *
 * Source: 40-RESEARCH Example 5 lines 588-592; 40-CONTEXT specifics
 * line 140. Dropped OKM fields per 40-RESEARCH Q2 #9: `entityIds`,
 * `errors`, `orphanNodeIds`, `confirmedCount`.
 */
export interface IngestResult {
  /** Entities returned by the extractor (0 when extract was skipped). */
  extractedCount: number;
  /** Dedup decisions that matched (0 when dedup was skipped). */
  mergedCount: number;
  /** Entities the store stage actually wrote. */
  storedCount: number;
  /** Entities the framework dropped without writing (pipeline-internal). */
  skippedCount: number;
  /** Entities removed by an extractor-side cap / PII filter. */
  droppedCount: number;
  /** Per-stage wall-clock (ms). 0 when the stage was skipped. */
  durations: {
    extractMs: number;
    dedupMs: number;
    storeMs: number;
    synthesizeMs: number;
  };
  /** Echoes back the IngestOpts.skipStages array (canonicalized). */
  skippedStages: StageName[];
}

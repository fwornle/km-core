// Public API barrel for @fwornle/km-core.
//
// Plan 02: canonical type surface (CORE-01) plus UUIDv7 ID layer (CORE-03).
// Plan 03: PersistenceManager + Exporter primitives.
// Plan 04: GraphKMStore repository class — full library surface (CORE-01/02/03).

export const KM_CORE_VERSION = '0.1.0';

// CORE-02: GraphKMStore composition class — repository API + UUIDv7 stamping
// + events + atomic per-domain JSON export.
export { GraphKMStore } from './store/GraphKMStore.js';
export type { GraphKMStoreOptions } from './store/GraphKMStore.js';

// CORE-03: UUIDv7 stamping + caller-supplied-id validation.
export { mintEntityId } from './ids/mint.js';
export { parseEntityId } from './ids/parse.js';

// CORE-01: canonical entity / relation / layer / id / serialized-graph types.
export type {
  Entity,
  Relation,
  Layer,
  SerializedGraph,
  ProvenanceStamp,
  EntityProvenance,
  SegmentConfirmation,
  DescriptionSegment,
  ResolutionRecord,
} from './types/entity.js';

export type { EntityId } from './ids/branded.js';

// Store API public types (D-17 BatchOp, D-18 FilterObject).
export type { BatchOp, FilterObject } from './store/types.js';

// Event payload types fired by GraphKMStore (D-16).
export type {
  EntityPutEvent,
  EntityDeleteEvent,
  RelationAddedEvent,
  RelationRemovedEvent,
} from './events/types.js';

// Pluggable ontology validator (D-19); v0.1 default is no-op.
// Phase 38 (ONTO-01/02): registryBackedValidator factory bridges the Phase 37
// pluggable-validator surface to the Phase 38 OntologyRegistry. Plan 38-05
// auto-wires this factory inside the GraphKMStore constructor when
// GraphKMStoreOptions.ontologyDir is set; standalone-usable for consumers
// that manage the registry lifecycle externally.
export type { OntologyValidator } from './validation/ontology.js';
export { noopOntologyValidator } from './validation/ontology.js';
export { registryBackedValidator } from './validation/ontology.js';

// Phase 38 (ONTO-01/02): OntologyRegistry — auto-discovers upper.json + sibling
// lower-ontology .json files in a configured directory, resolves per-class
// extends chains with child-wins property/relationship merging, exposes
// provenance + parent-chain accessors, and supports atomic reload (D-29).
// The registry is auto-wired into GraphKMStore by Plan 38-05 when
// GraphKMStoreOptions.ontologyDir is set; standalone use via the class.
export { OntologyRegistry } from './ontology/registry.js';
export type { OntologyRegistryOptions } from './ontology/registry.js';
export { loadOntologyFile } from './ontology/loader.js';
export type {
  OntologyFile,
  OntologyClass,
  OntologyProperty,
  ResolvedClass,
} from './types/ontology.js';

// Phase 39 (DATA-02): per-segment provenance merge helper. Pure function,
// no store coupling; caller invokes BEFORE `store.putEntity` to fold new
// text into `entity.metadata.descriptionSegments[]` (append-confirmation
// on whitespace-normalized identical text per D-40, else push new segment
// per D-39). D-41 monitoring at the 100-segments / 50-confirmations
// thresholds via `process.stderr.write` (no `console.*`).
export { mergeDescriptionSegment } from './segments/merge.js';

// Phase 39 (DATA-01/DATA-02): backfillEntityDataModel library function +
// BackfillOptions + BackfillResolver + BackfillResult types. Per-system
// migration scripts (Phase 41 / 42 / 43) call this to stamp `validFrom`
// + synthetic `EntityProvenance` on legacy entities lacking them
// (D-36 + D-37 + D-38). Idempotent, resumable via atomic checkpoint
// (CF-D29 temp+rename), supports `dryRun:true`.
export { backfillEntityDataModel } from './backfill/index.js';
export type {
  BackfillOptions,
  BackfillResolver,
  BackfillResult,
} from './backfill/index.js';

// Phase 40 (PIPE-01 + DEDUP-01): 4-stage ingest framework + layered
// deduplication primitives. Caller-pluggable Extractor / Synthesizer /
// EmbeddingClient / LLMClient interfaces — A and B (Phase 41/42) wire
// their own concrete clients. Per-layer thresholds on the layer ctors;
// short-circuit-on-first-match per D-44. Pipeline threads ProvenanceStamp
// through all 4 stages; the store stage uses Phase 39 putEntity which
// handles supersession closure atomically (CR-01 widening covers legacy
// non-v7 predecessor ids).
export { IngestPipeline } from './pipeline/IngestPipeline.js';
export type {
  IngestPipelineOpts,
  IngestOpts,
  IngestResult,
  PhaseCallback,
  StageName,
  Extractor,
  Synthesizer,
} from './pipeline/types.js';

export { LayeredDeduplicator } from './dedup/LayeredDeduplicator.js';
export { JaccardNameMatcher } from './dedup/JaccardNameMatcher.js';
export { CosineEmbeddingMatcher } from './dedup/CosineEmbeddingMatcher.js';
export { LLMSemanticMatcher } from './dedup/LLMSemanticMatcher.js';
export type {
  ExactNameLayer,
  EmbeddingLayer,
  LLMSemanticLayer,
  MatchResult,
  DedupResult,
  EmbeddingClient,
  LLMClient,
} from './dedup/types.js';

// Phase 41 (INT-01 + PIPE-02): online-learning adapter +
// post-hoc resolveEntities + atomic mergeEntities primitive.
//
// INT-01 — Plan 41-02/04: thin read-only adapter that maps A's
// .data/observation-export/{observations,digests,insights}.json rows to
// KM-Core Entity instances, plus a library-function `reprojectFromOnlineStore`
// that pre-stamps Entity.legacyId (top-level, CF-D37) + emits aggregation
// edges. SC#2 enforced by construction — adapter never opens A's writer.
//
// PIPE-02 — Plan 41-05/06: atomic `mergeEntities` primitive (D-50 four-step
// batch: close duplicate + SUPERSEDED_BY edge + edge rewires + segment
// fold + survivor write) + user-facing `resolveEntities` post-hoc resolver
// that wraps Plans 01 (ontology) + 03 (getDegree) + 05 (mergeEntities) +
// 40 (LLMSemanticLayer) into one callable surface. Operators call
// `resolveEntities(store, { llmMatcher, provenance, classes?, dryRun? })`
// from a per-system script (Plan 41-07) or future Phase 44 REST route.
//
// Both sub-paths also ship as standalone sub-barrels for consumers who
// prefer narrower imports:
//   import { reprojectFromOnlineStore } from '@fwornle/km-core/adapters/online';
//   import { resolveEntities, mergeEntities } from '@fwornle/km-core/maintenance';
export { reprojectFromOnlineStore } from './adapters/online/index.js';
export type {
  ReprojectOptions,
  ReprojectResult,
  ReprojectCheckpoint,
  ReprojectSources,
  ProgressEvent,
} from './adapters/online/index.js';
export {
  mapObservationRow,
  mapDigestRow,
  mapInsightRow,
} from './adapters/online/index.js';
export type {
  ObservationRow,
  DigestRow,
  InsightRow,
} from './adapters/online/index.js';
export { resolveEntities, mergeEntities } from './maintenance/index.js';
export type {
  ResolveOptions,
  ResolveResult,
  ResolveEvent,
  MergeOptions,
  MergeResult,
} from './maintenance/index.js';

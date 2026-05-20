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

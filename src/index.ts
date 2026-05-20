// Public API barrel for @fwornle/km-core.
//
// Plan 02: canonical type surface (CORE-01) plus UUIDv7 ID layer (CORE-03).
// Plans 03 and 04 will add `PersistenceManager`, `Exporter`, and the
// `GraphKMStore` repository class.

export const KM_CORE_VERSION = '0.1.0-pre';

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
export type { OntologyValidator } from './validation/ontology.js';
export { noopOntologyValidator } from './validation/ontology.js';

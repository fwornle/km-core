// Barrel re-exports for the `src/types/` module.
//
// `EntityId` is re-exported here (it logically belongs with the entity shape
// even though it lives in `src/ids/branded.ts`) so consumers can do a single
// `import type { Entity, EntityId } from '@fwornle/km-core/types'` if they
// only need the type surface.

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
} from './entity.js';

export type { EntityId } from '../ids/branded.js';

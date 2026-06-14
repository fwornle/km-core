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

// Phase 57 D-03 — Project type registry (PROJECTS const tuple,
// Project literal-union, isProject runtime typeguard). Single source of
// truth for the `metadata.project` dimension stamped onto every km-core
// entity by Phase 57 writers + readable by viewer / dashboard filters.
export { PROJECTS, isProject } from './project.js';
export type { Project } from './project.js';

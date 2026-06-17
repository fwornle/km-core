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

// Phase 60 D-14 + D-23 — Hierarchy roots registry (HIERARCHY_ROOTS const
// tuple, HierarchyRoot literal-union, HIERARCHY_ROOT_CLASS lookup map,
// isHierarchyRoot runtime typeguard). Closed-set of entity names whose
// `ontologyClass` is hard-locked at the writer + LLM-classifier boundary.
// Consumed by the Phase 60 writer guard
// (mcp-server-semantic-analysis/.../ontology-classification-agent.ts) and
// the one-shot repair script (scripts/repair-ck-ontology-class.mjs).
export { HIERARCHY_ROOTS, HIERARCHY_ROOT_CLASS, isHierarchyRoot } from './hierarchy-roots.js';
export type { HierarchyRoot } from './hierarchy-roots.js';

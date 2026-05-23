// Barrel re-exports for the `src/maintenance/` module (Phase 41 PIPE-02).
//
// Consumers needing the post-hoc maintenance surface in one import:
//   import { resolveEntities, mergeEntities } from '@fwornle/km-core/maintenance';
//   import type {
//     ResolveOptions, ResolveResult, ResolveEvent,
//     MergeOptions, MergeResult,
//   } from '@fwornle/km-core/maintenance';
//
// The sub-path `@fwornle/km-core/maintenance` is wired in package.json
// `exports` (Plan 06 Task 3 — mirrors Phase 40's `./dedup` sub-path
// precedent). Consumers may also reach these symbols through the root
// barrel (`@fwornle/km-core`) — both import paths resolve to the same
// module.
//
// Plans landed in this sub-barrel:
//   - Plan 05 (mergeEntities): atomic per-merge primitive — D-50 four-step
//     batch (close duplicate + SUPERSEDED_BY edge + edge rewires + segment
//     fold + survivor write). Reused by Phase 42 (B) and Phase 43 (C)
//     during their migrations (D-50a).
//   - Plan 06 (resolveEntities): user-facing PIPE-02 cross-batch duplicate
//     resolver. Wraps Plans 01 (ontology) + 03 (getDegree) + 05
//     (mergeEntities) + caller-supplied LLMSemanticLayer (Plan 40) into
//     one callable surface.
//   - Phase 42 Plan 04 (syncQdrantFromStore): post-hoc Qdrant rebuild from
//     km-core's canonical entity store. Reads all entities with non-empty
//     embedding and upserts them to a caller-supplied Qdrant client
//     (km-core stays Qdrant-agnostic at the type level — D-52a).

export { resolveEntities } from './resolveEntities.js';
export { mergeEntities } from './mergeEntities.js';
export { syncQdrantFromStore } from './syncQdrantFromStore.js';
export type {
  ResolveOptions,
  ResolveResult,
  ResolveEvent,
} from './resolveEntities.js';
export type { MergeOptions, MergeResult } from './mergeEntities.js';
export type {
  QdrantClient,
  SyncQdrantOptions,
  SyncQdrantResult,
  SyncQdrantEvent,
} from './syncQdrantFromStore.js';

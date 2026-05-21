// Store-API public types (D-17 `BatchOp`, D-18 `FilterObject`,
// Phase 39 D-30/D-31/D-32 `PutEntityOpts`).
//
// All shapes are net-new to KM-Core (OKM and B never exposed typed
// batch / filter primitives). The shapes are fixed by 37-PATTERNS
// §src/store/types.ts and reflect CONTEXT decisions D-14, D-17, D-18,
// D-30, D-31, D-32.

import type { Entity, Relation, ProvenanceStamp } from '../types/entity.js';
import type { EntityId } from '../ids/branded.js';

/**
 * Atomic, all-or-nothing batch operation (D-17). Plan 04 maps these to
 * LevelDB atomic batches and applies them to Graphology only after the
 * LevelDB commit succeeds.
 *
 * Per-op `skipOntologyCheck` (Phase 39 CR-01 widening): mirrors the same
 * BC-2 escape hatch that `PutEntityOpts.skipOntologyCheck` provides for the
 * single-call `putEntity`. When `true`, Phase 1 validation bypasses BOTH
 * the ontology validator AND `parseEntityId` for this op's entity — required
 * for cross-epoch supersession closures where the predecessor entity was
 * originally stored on the trusted path with a non-v7 id (legacy nanoid,
 * C's `layer:uuid` prefix, or any backfill-stamped legacy id). Without
 * this flag, the supersession closure's batch would silently throw on
 * Phase 1 `parseEntityId` for legacy-keyed predecessors, breaking D-33
 * atomicity. See CR-01 in `.planning/phases/39-entity-data-model/39-REVIEW.md`.
 */
export type BatchOp =
  | {
      type: 'putEntity';
      entity: Partial<Entity> & { name: string; entityType: string };
      skipOntologyCheck?: boolean;
    }
  | { type: 'deleteEntity'; id: EntityId }
  | { type: 'addRelation'; relation: Relation }
  | { type: 'removeRelation'; relation: Relation };

/**
 * Predicate object for `store.iterate(filter)` (D-18). v0.1 ships these
 * three predicates; Phase 38 may extend with metadata-key predicates once
 * the ontology registry is wired.
 */
export interface FilterObject {
  entityType?: string;
  ontologyClass?: string;
  layer?: 'evidence' | 'pattern';
}

/**
 * Options bag for `GraphKMStore.putEntity` (Phase 39 D-30/D-31/D-32).
 *
 * Combines the Phase 37 trusted-caller bypass (`skipOntologyCheck`) with
 * the Phase 39 writer-side provenance stamp source (`provenance`).
 *
 * - `skipOntologyCheck: true` — bulk-import / trusted-caller path.
 *   Bypasses BOTH ontology validation AND `parseEntityId` (Phase 37 BC-2
 *   widening). Phase 39 ALSO bypasses the D-30 provenance requirement on
 *   this path; backfill callers stamp `metadata.provenance` themselves
 *   before calling `putEntity` with this flag.
 * - `provenance` — required on the strict (default) path per D-30. The
 *   store NEVER invents a ProvenanceStamp; the caller MUST supply the
 *   `{ provider, model, runId, timestamp }` source. On first write the
 *   store sets `createdBy = lastConfirmedBy = provenance` and
 *   `confirmationCount = 1`; on subsequent writes for the same id, the
 *   store preserves `createdBy`, updates `lastConfirmedBy = provenance`,
 *   and increments `confirmationCount` (D-32).
 */
export interface PutEntityOpts {
  skipOntologyCheck?: boolean;
  provenance?: ProvenanceStamp;
}

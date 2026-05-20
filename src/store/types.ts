// Store-API public types (D-17 `BatchOp`, D-18 `FilterObject`).
//
// Both shapes are net-new to KM-Core (OKM and B never exposed typed
// batch / filter primitives). The shapes are fixed by 37-PATTERNS
// §src/store/types.ts and reflect CONTEXT decisions D-14, D-17, D-18.

import type { Entity, Relation } from '../types/entity.js';
import type { EntityId } from '../ids/branded.js';

/**
 * Atomic, all-or-nothing batch operation (D-17). Plan 04 maps these to
 * LevelDB atomic batches and applies them to Graphology only after the
 * LevelDB commit succeeds.
 */
export type BatchOp =
  | { type: 'putEntity'; entity: Partial<Entity> & { name: string; entityType: string } }
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

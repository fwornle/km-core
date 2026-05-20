// Event payload types for the 4 events fired by `GraphKMStore` (D-16).
//
// Plan 04 wires the actual emitter on `GraphKMStore extends EventEmitter`.
// The payload shapes are net-new to KM-Core — neither OKM nor B exposes
// typed events on its store — and are referenced from 37-PATTERNS
// §src/events/types.ts.
//
// Event names: 'entity:put' | 'entity:delete' | 'relation:added' | 'relation:removed'
// (decided in D-16; consumers may subscribe via Node's EventEmitter API).

import type { Entity, Relation } from '../types/entity.js';

export interface EntityPutEvent {
  entity: Entity;
}

export interface EntityDeleteEvent {
  id: string;
}

export interface RelationAddedEvent {
  relation: Relation;
}

export interface RelationRemovedEvent {
  relation: Relation;
}

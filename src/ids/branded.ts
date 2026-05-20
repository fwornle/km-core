/**
 * Branded `EntityId` type — compile-time tag that prevents raw `string`
 * values from being accidentally accepted where an entity identifier is
 * required (Phase 37 decision D-11).
 *
 * Zero runtime cost: the `__brand` field exists only in the type system.
 * The canonical way to construct an `EntityId` is `mintEntityId()`
 * (fresh UUIDv7) or `parseEntityId(s)` (validate a caller-supplied string).
 */
export type EntityId = string & { readonly __brand: 'EntityId' };

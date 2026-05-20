// Public API barrel for @fwornle/km-core.
//
// Plan 02 / Task 1: expose the UUIDv7 ID layer (D-08 / D-09 / D-11).
// Plan 02 / Task 2 will extend this with the canonical Entity/Relation/Layer
// /EntityId/SerializedGraph type re-exports plus BatchOp/FilterObject and
// the event payload types.

export const KM_CORE_VERSION = '0.1.0-pre';

export { mintEntityId } from './ids/mint.js';
export { parseEntityId } from './ids/parse.js';

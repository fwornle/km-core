// Barrel re-exports for the `src/segments/` module (Phase 39, DATA-02).
//
// Consumers needing the per-segment provenance merge helper in one import:
//   import { mergeDescriptionSegment } from '@fwornle/km-core/segments';
//
// The symbol is also re-exported through the root barrel
// (`@fwornle/km-core`) — both import paths resolve to the same module.
// Phase 40 ingest pipeline + Phase 42 B migration are the primary callers.

export { mergeDescriptionSegment } from './merge.js';

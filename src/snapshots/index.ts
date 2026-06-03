// Barrel re-exports for the `src/snapshots/` module (Phase 44, S-1/S-2/S-4).
//
// Consumers reach the snapshot surface in one import:
//   import { SnapshotManager } from '@fwornle/km-core/snapshots';
//   import type { SnapshotEntry, SnapshotManagerOptions } from '@fwornle/km-core/snapshots';
//
// The sub-path `@fwornle/km-core/snapshots` is wired in package.json `exports`
// (added in Phase 44 Plan 03 to avoid Wave 1 file-conflict).

export { SnapshotManager } from './SnapshotManager.js';
export type { SnapshotEntry, SnapshotManagerOptions } from './SnapshotManager.js';

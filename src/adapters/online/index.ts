// Phase 41 (INT-01): online-learning adapter sub-barrel.
//
// Consumers needing the adapter in one import:
//   import {
//     reprojectFromOnlineStore,
//     mapObservationRow,
//     mapDigestRow,
//     mapInsightRow,
//   } from '@fwornle/km-core/adapters/online';
//
// Style matches `src/dedup/index.ts` (runtime exports + type exports
// separated; block-comment lists the consumer import path).

// Runtime exports
export { reprojectFromOnlineStore } from './reprojectFromOnlineStore.js';
export {
  mapObservationRow,
  mapDigestRow,
  mapInsightRow,
} from './mapper.js';
export {
  readReprojectCheckpoint,
  writeReprojectCheckpointAtomic,
} from './checkpoint.js';

// Type exports
export type {
  ReprojectOptions,
  ReprojectResult,
  ReprojectSources,
  ProgressEvent,
} from './reprojectFromOnlineStore.js';
export type {
  ObservationRow,
  DigestRow,
  InsightRow,
} from './mapper.js';
export type { ReprojectCheckpoint } from './checkpoint.js';

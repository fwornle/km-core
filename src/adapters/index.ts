// Phase 44 Plan 12: adapters sub-barrel.
//
// Consumers can import all reshape adapters in one statement:
//   import {
//     observationToLegacy, digestToLegacy, insightToLegacy,
//     legacyObservationToEntity, legacyDigestToEntity, legacyInsightToEntity,
//   } from '@fwornle/km-core/adapters';
//
// Style mirrors `src/adapters/online/index.ts` — runtime exports first,
// then type exports. Each function is a pure transformer with no I/O.
//
// Both modules represent the SAME field-map in opposite directions:
//   * observation-view.ts: km-core Entity → legacy SQLite-shaped row
//     (Plan 44-05, A's read-path typed views at /api/coding/*)
//   * legacy-ingest.ts:    legacy SQLite-shaped row → km-core Entity
//     (Plan 44-12, A's write-path cutover from SQLite to km-core)
//
// The two adapters MUST stay in sync — round-trip parity is a Phase 44
// invariant (write via Plan 44-12, read via Plan 44-07/05).

// Runtime exports — Plan 44-05 (read direction).
export {
  observationToLegacy,
  digestToLegacy,
  insightToLegacy,
} from './observation-view.js';

// Runtime exports — Plan 44-12 (write direction).
export {
  legacyObservationToEntity,
  legacyDigestToEntity,
  legacyInsightToEntity,
} from './legacy-ingest.js';

// Type exports — Plan 44-05.
export type {
  LegacyObservation,
  LegacyDigest,
  LegacyInsight,
} from './observation-view.js';

// Type exports — Plan 44-12.
export type {
  LegacyObservationRow,
  LegacyDigestRow,
  LegacyInsightRow,
  LegacyIngestOptions,
} from './legacy-ingest.js';

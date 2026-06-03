// Barrel re-exports for the `src/api/` module (Phase 44, API-01).
//
// Consumers needing the canonical REST contract surface in one import:
//   import { EntitySchema, ApiSuccessEnvelope } from '@fwornle/km-core/api';
//   import type { Entity, Relation } from '@fwornle/km-core/api';
//
// The sub-path `@fwornle/km-core/api` is wired in package.json `exports`
// (added in this plan per 44-PATTERNS.md § `lib/km-core/package.json`). The
// finer-grained `@fwornle/km-core/api/contracts` sub-path is wired in
// parallel — consumers may import from either path. Once Plan 44-06 lands
// the root-barrel re-export, the symbols also become reachable via
// `@fwornle/km-core` directly.
//
// Plan 44-06 will add `createKmCoreRouter` to this barrel; this plan ships
// only the contracts surface.

export {
  ProvenanceStampSchema,
  EntitySchema,
  RelationSchema,
  OntologyClassSchema,
  StatsSchema,
  ApiSuccessEnvelope,
  EntityResponse,
  EntitiesEndpointResponse,
  RelationResponse,
  RelationsEndpointResponse,
  OntologyClassResponse,
  OntologyClassesEndpointResponse,
  StatsResponse,
} from './contracts.js';

export type {
  ProvenanceStamp,
  Entity,
  Relation,
  OntologyClass,
  Stats,
  EntityResponseT,
  EntitiesEndpointResponseT,
  RelationResponseT,
  RelationsEndpointResponseT,
  OntologyClassResponseT,
  OntologyClassesEndpointResponseT,
  StatsResponseT,
} from './contracts.js';

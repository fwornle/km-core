// Barrel re-exports for the `src/api/` module (Phase 44, API-01).
//
// Consumers needing the canonical REST contract surface in one import:
//   import { EntitySchema, ApiSuccessEnvelope } from '@fwornle/km-core/api';
//   import type { Entity, Relation } from '@fwornle/km-core/api';
//
// The sub-path `@fwornle/km-core/api` is wired in package.json `exports`
// (added in this plan per 44-PATTERNS.md § `lib/km-core/package.json`). The
// finer-grained `@fwornle/km-core/api/contracts` sub-path is wired in
// parallel — consumers may import from either path.
//
// Plan 44-06 adds `createKmCoreRouter` + `createKMRoutes` plus the supporting
// types to this barrel. The factory attaches the 15 canonical /api/v1 endpoint
// handlers to a caller-supplied Router-like object (CONTEXT R-2 revised —
// km-core stays Express-free; caller passes their own Router instance).

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

// Phase 44 Plan 06: keystone router factory + framework-agnostic route descriptors.
export { createKmCoreRouter, createKMRoutes } from './router.js';
export type {
  KmCoreRouterOptions,
  RouterLike,
  RouteDescriptor,
} from './router.js';

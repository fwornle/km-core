// Barrel re-exports for the `src/api/` module (Phase 44, API-01).
//
// Consumers needing the canonical REST contract surface in one import:
//   import { EntitySchema, ApiSuccessEnvelope } from '@fwornle/km-core/api';
//   import type { Entity, Relation } from '@fwornle/km-core/api';
//
// `EntitySchema` / `RelationSchema` / `StatsSchema` resolve to the WIRE shape
// (HTTP contract of record per 44-CONTEXT-amendment.md). For the in-process
// rich shape, import the explicit `*Domain*` symbols.
//
// The sub-path `@fwornle/km-core/api` is wired in package.json `exports`. The
// finer-grained `@fwornle/km-core/api/contracts` sub-path is wired in parallel.
//
// Plan 44-06 adds `createKmCoreRouter` + `createKMRoutes` plus the supporting
// types to this barrel. The factory attaches the 15 canonical /api/v1 endpoint
// handlers to a caller-supplied Router-like object (CONTEXT R-2 revised —
// km-core stays Express-free; caller passes their own Router instance).

export {
  ProvenanceStampSchema,
  // Domain (in-process rich) schemas
  EntityDomainSchema,
  RelationDomainSchema,
  // Wire (HTTP boundary) schemas
  EntityWireSchema,
  RelationWireSchema,
  StatsWireSchema,
  EntityProvenanceSchema,
  MetadataSchema,
  SearchResultSchema,
  ClusterSchema,
  RcaConfidenceSchema,
  RcaChainStepSchema,
  RcaMatchSchema,
  // HTTP-default aliases (= wire schemas)
  EntitySchema,
  RelationSchema,
  StatsSchema,
  // Envelope helper
  ApiSuccessEnvelope,
  // Pre-composed wire envelopes
  EntityResponse,
  EntitiesEndpointResponse,
  RelationResponse,
  RelationsEndpointResponse,
  StatsResponse,
  SearchEndpointResponse,
  ClustersEndpointResponse,
  ExportEndpointResponse,
  OntologyClassesWireResponse,
  OntologyEntityTypesWireResponse,
  GraphConnectivityEndpointResponse,
  RcaLookupEndpointResponse,
} from './contracts.js';

export type {
  ProvenanceStamp,
  // HTTP-default inferred types (= wire shapes)
  Entity,
  Relation,
  Stats,
  // Wire-shape inferred types
  EntityWire,
  RelationWire,
  StatsWire,
  EntityProvenance,
  SearchResult,
  Cluster,
  RcaConfidence,
  RcaChainStep,
  RcaMatch,
  // Domain-shape inferred types
  EntityDomain,
  RelationDomain,
  // Envelope inferred types
  EntityResponseT,
  EntitiesEndpointResponseT,
  RelationResponseT,
  RelationsEndpointResponseT,
  StatsResponseT,
  SearchEndpointResponseT,
  ClustersEndpointResponseT,
  ExportEndpointResponseT,
  OntologyClassesWireResponseT,
  OntologyEntityTypesWireResponseT,
  GraphConnectivityEndpointResponseT,
  RcaLookupEndpointResponseT,
} from './contracts.js';

// Phase 44 Plan 06: keystone router factory + framework-agnostic route descriptors.
export { createKmCoreRouter, createKMRoutes } from './router.js';
export type {
  KmCoreRouterOptions,
  RouterLike,
  RouteDescriptor,
} from './router.js';

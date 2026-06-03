// Phase 44 — km-core canonical REST contract (Zod schemas + inferred TS types).
//
// 2026-06-03 AMENDMENT (44-CONTEXT-amendment.md): Plan 44-09 surfaced a
// conflation between in-process Entity domain types and the OKM JSON wire
// shape. This file now keeps the two clearly separated:
//
//   §1 Domain types — in-process rich Entity / Relation shapes
//      (legacyId / embedding / validFrom etc. at the top level).
//
//   §2 Wire types — verbatim lift from OKM
//      `tests/integration/rest-contract.test.ts:94-287`. These are the
//      HTTP contract of record (Phase 43 D-G5.1 byte-equal fixture lock).
//
//   §3 HTTP-default aliases — `EntitySchema = EntityWireSchema` etc., so
//      consumers importing the unprefixed symbol get the wire shape (what
//      flows across the network). Domain consumers use the `*Domain*`
//      symbols explicitly.
//
// Source of truth for wire schemas:
//   `_work/rapid-automations/integrations/operational-knowledge-management/
//    tests/integration/rest-contract.test.ts` lines 94-287 — every wire
//    schema below is a verbatim copy of that block.
//
// Why the wire shape is canonical for Phase 44+:
//   Phase 43 locked OKM's wire shape via the D-G5.1 byte-equal fixture set.
//   Phase 44 must serialize INTO that shape (no shape negotiation; the
//   adapter layer is `src/adapters/wire-serializers.ts`). Phase 45's
//   unified viewer will consume the same wire shape.
//
// CONSUMERS:
//   import { EntitySchema, ApiSuccessEnvelope } from '@fwornle/km-core/api/contracts';
//   import type { Entity, Relation, EntityResponse } from '@fwornle/km-core/api/contracts';
//     ^^ `Entity` resolves to the wire-shape inferred type.
//   import { EntityDomainSchema } from '@fwornle/km-core/api/contracts';
//   import type { EntityDomain } from '@fwornle/km-core/api/contracts';
//     ^^ rich in-process shape for migration / typed views.
//
// no-console-log: schemas are pure data — no diagnostic emission. Errors
// surface via Zod's `.parse()` throw / `.safeParse()` result-object path;
// router error wrapper emits the `{success:false,error:<msg>}` envelope (V7
// control per 44-RESEARCH § Threat T-44-03-02).
//
// no-parallel-versions (lib/km-core/CLAUDE.md): file is EXACTLY `contracts.ts`.
// No `contracts-v2.ts`, `enhanced-contracts.ts`, etc. Edit this file in place
// when extending.

import { z } from 'zod';

// ============================================================================
// §1 — DOMAIN TYPES (in-process rich Entity / Relation)
// ============================================================================
//
// These mirror `src/types/entity.ts`. They are useful for migration callers
// and any in-process consumer that needs the rich shape (legacyId, embedding,
// validFrom, validUntil, supersedes, top-level provenance fields). They are
// NOT the HTTP wire shape — to emit over HTTP, route the domain object
// through `src/adapters/wire-serializers.ts` first.

/**
 * Provenance stamp: tracks which LLM run created or confirmed an entity.
 * Phase 39 D-30 — non-optional fields when present; the Entity may omit the
 * stamp entirely (legacy Phase 37 entities) but a stamp object always carries
 * all four fields.
 *
 * Same identity as the wire ProvenanceStamp — sub-schema reused below.
 */
export const ProvenanceStampSchema = z.object({
  provider: z.string(),
  model: z.string(),
  runId: z.string(),
  timestamp: z.string(),
});

/**
 * Domain Entity shape — in-process rich Entity (Phase 39/41/42 fields at the
 * top level). This is the predecessor `EntitySchema`. Renamed to disambiguate
 * from the HTTP wire shape.
 */
export const EntityDomainSchema = z.object({
  id: z.string(),
  name: z.string(),
  entityType: z.string(),
  ontologyClass: z.string().optional(),
  layer: z.enum(['evidence', 'pattern']),
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  // Phase 39 optional fields:
  validFrom: z.string().optional(),
  validUntil: z.string().nullable().optional(),
  supersedes: z.array(z.string()).optional(),
  createdBy: ProvenanceStampSchema.optional(),
  lastConfirmedBy: ProvenanceStampSchema.optional(),
  confirmationCount: z.number().int().nonnegative().optional(),
  // Phase 41 origin-system bridge:
  legacyId: z
    .object({
      system: z.enum(['A', 'B', 'C']),
      id: z.string(),
    })
    .optional(),
  // Phase 42 embedding (D-52):
  embedding: z.array(z.number()).optional(),
});

/**
 * Domain Relation shape — in-process relation as held by GraphKMStore /
 * `src/types/entity.ts`. Predecessor `RelationSchema`. Renamed to disambiguate
 * from the wire shape (which is the graphology edge envelope).
 */
export const RelationDomainSchema = z.object({
  from: z.string(),
  to: z.string(),
  key: z.string().optional(),
  relationType: z.string(),
  createdAt: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================================
// §2 — WIRE TYPES (verbatim from OKM rest-contract.test.ts:94-287)
// ============================================================================
//
// Each schema below is a byte-for-byte port of the corresponding OKM line
// range. The fixture lock at OKM `tests/fixtures/pre-migration/api-*.json`
// is the byte-equal contract; do NOT edit these except by porting the
// corresponding edit in OKM first.

// OKM lines 101-105
/**
 * Provenance bag carried inside `EntityWire.metadata.provenance`. Wraps two
 * stamps + a confirmation count. Verbatim from OKM rest-contract.test.ts:101.
 */
export const EntityProvenanceSchema = z.object({
  createdBy: ProvenanceStampSchema,
  lastConfirmedBy: ProvenanceStampSchema,
  confirmationCount: z.number().int().nonnegative(),
});

// OKM line 107
/**
 * Open-ended metadata bag. Verbatim from OKM rest-contract.test.ts:107.
 */
export const MetadataSchema = z.record(z.string(), z.unknown());

// OKM lines 109-122
/**
 * Wire-shape Entity — what crosses the HTTP boundary. Provenance lives INSIDE
 * `metadata.provenance` (not at the top level). Phase 39 D-30 fields
 * (createdBy, lastConfirmedBy, confirmationCount) and Phase 41 / 42 fields
 * (legacyId, embedding, validFrom, validUntil, supersedes) DO NOT surface
 * on the wire — they are stripped by `entityToWire`.
 *
 * Verbatim from OKM rest-contract.test.ts:109-122.
 */
export const EntityWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  entityType: z.string(),
  ontologyClass: z.string().optional(),
  layer: z.enum(['evidence', 'pattern']),
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  metadata: z
    .object({
      domain: z.string().optional(),
      provenance: EntityProvenanceSchema.optional(),
    })
    .and(MetadataSchema),
});

// OKM lines 129-138
/**
 * Wire-shape Relation — graphology edge envelope. Verbatim from OKM
 * rest-contract.test.ts:129-138.
 */
export const RelationWireSchema = z.object({
  key: z.string(),
  source: z.string(),
  target: z.string(),
  attributes: z.object({
    type: z.string(),
    metadata: MetadataSchema,
    createdAt: z.string(),
  }),
});

// OKM lines 142-156
/**
 * Wire-shape SearchResult — single flat row produced by `/search`. Verbatim
 * from OKM rest-contract.test.ts:142-149.
 */
export const SearchResultSchema = z.object({
  nodeId: z.string(),
  name: z.string(),
  entityType: z.string(),
  layer: z.string(),
  score: z.number(),
  description: z.string(),
});

/**
 * Wire-shape envelope for `/search`. Verbatim from OKM
 * rest-contract.test.ts:151-156.
 */
// NOTE: SearchEndpointResponse bound after ApiSuccessEnvelope is declared (below).

// OKM lines 158-170
/**
 * Wire-shape Cluster — single Louvain community. Verbatim from OKM
 * rest-contract.test.ts:158-162.
 */
export const ClusterSchema = z.object({
  id: z.number().int().nonnegative(),
  nodeIds: z.array(z.string()),
  size: z.number().int().nonnegative(),
});

// OKM lines 172-214 (RCA — OKM-specific surface, lives here for completeness)
/**
 * Wire-shape RCA confidence bag. Verbatim from OKM
 * rest-contract.test.ts:172-176.
 *
 * NOTE: RCA endpoints are OKM-specific and are mounted under `/api/okm/*`
 * by Plan 44-09. The schema lives in km-core for symmetry; km-core does
 * not register an RCA handler.
 */
export const RcaConfidenceSchema = z.object({
  score: z.number(),
  label: z.string(),
  factors: z.record(z.string(), z.number()),
});

/**
 * Wire-shape RCA causal-chain step. Verbatim from OKM
 * rest-contract.test.ts:178-187.
 */
export const RcaChainStepSchema = z.object({
  nodeId: z.string(),
  name: z.string(),
  entityType: z.string(),
  layer: z.string(),
  relationship: z.string(),
  direction: z.enum(['incoming', 'outgoing']),
  depth: z.number().int().nonnegative(),
  description: z.string(),
});

/**
 * Wire-shape RCA match — a single hit returned by `/api/okm/rca/lookup`.
 * Verbatim from OKM rest-contract.test.ts:189-206.
 */
export const RcaMatchSchema = z.object({
  nodeId: z.string(),
  entity: z.object({
    id: z.string(),
    name: z.string(),
    entityType: z.string(),
    ontologyClass: z.string().optional(),
    layer: z.string(),
    description: z.string(),
    domain: z.string().optional(),
  }),
  relevanceScore: z.number(),
  confidence: RcaConfidenceSchema,
  combinedScore: z.number(),
  causalChain: z.array(RcaChainStepSchema),
  knownFixes: z.array(z.unknown()),
  evidenceLinks: z.array(z.unknown()),
});

// OKM lines 216-229
/**
 * Wire-shape Stats — exactly the 10 fields OKM's `/api/stats` emits.
 * `activeSnapshot` is nullable (NOT optional). Verbatim from OKM
 * rest-contract.test.ts:216-229.
 */
export const StatsWireSchema = z.object({
  nodes: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
  evidenceCount: z.number().int().nonnegative(),
  patternCount: z.number().int().nonnegative(),
  orphanCount: z.number().int().nonnegative(),
  islandCount: z.number().int().nonnegative(),
  componentCount: z.number().int().nonnegative(),
  connectivity: z.number(),
  lastUpdated: z.string(),
  activeSnapshot: z.unknown().nullable(),
});

// --- Success envelope -------------------------------------------------------

/**
 * Wire envelope for canonical success responses: `{ success: true, data: ... }`.
 * Plan 06's router uses `res.json({ success: true, data })` for all 2xx
 * responses. The `success` field is a literal `true` — error responses use a
 * separate `{ success: false, error: string }` envelope (defined in Plan 06).
 *
 * Usage:
 *   const Schema = ApiSuccessEnvelope(EntitySchema);
 *   Schema.parse({ success: true, data: <entity> });
 *
 *   const ArraySchema = ApiSuccessEnvelope(z.array(EntitySchema));
 *   ArraySchema.parse({ success: true, data: [<e1>, <e2>] });
 */
export const ApiSuccessEnvelope = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ success: z.literal(true), data });

// OKM lines 151-156 — SearchEndpointResponse
export const SearchEndpointResponse = ApiSuccessEnvelope(
  z.object({
    results: z.array(SearchResultSchema),
    total: z.number().int().nonnegative(),
  }),
);

// OKM lines 164-170 — ClustersEndpointResponse
export const ClustersEndpointResponse = ApiSuccessEnvelope(
  z.object({
    clusters: z.array(ClusterSchema),
    count: z.number().int().nonnegative(),
    modularity: z.number(),
  }),
);

// OKM lines 208-214 — RcaLookupEndpointResponse
export const RcaLookupEndpointResponse = ApiSuccessEnvelope(
  z.object({
    matches: z.array(RcaMatchSchema),
    query: z.string(),
    totalCandidates: z.number().int().nonnegative(),
  }),
);

// OKM lines 231-255 — ExportEndpointResponse
/**
 * Wire-shape Export envelope. Mirrors graphology's `.export()` output PLUS
 * the wire-shape Entity attributes (so node attrs round-trip through the
 * fixture lock). Verbatim from OKM rest-contract.test.ts:231-255.
 */
export const ExportEndpointResponse = ApiSuccessEnvelope(
  z.object({
    options: z.object({
      type: z.string(),
      multi: z.boolean(),
      allowSelfLoops: z.boolean(),
    }),
    attributes: z.record(z.string(), z.unknown()),
    nodes: z.array(
      z.object({
        key: z.string(),
        attributes: EntityWireSchema,
      }),
    ),
    edges: z.array(
      z.object({
        key: z.string(),
        source: z.string(),
        target: z.string(),
        attributes: z.object({
          type: z.string(),
          metadata: MetadataSchema,
          createdAt: z.string(),
        }),
        undirected: z.boolean().optional(),
      }),
    ),
  }),
);

// OKM line 257 — `/api/ontology/classes` returns an array of class-name strings.
/**
 * Wire-shape envelope for `/ontology/classes` — array of class name strings.
 * Verbatim from OKM rest-contract.test.ts:257.
 */
export const OntologyClassesWireResponse = ApiSuccessEnvelope(z.array(z.string()));

// OKM lines 259-267 — `/api/ontology/entity-types` returns array of {name, description, source}.
/**
 * Wire-shape envelope for `/ontology/entity-types` — array of {name, description, source}.
 * Verbatim from OKM rest-contract.test.ts:259-267.
 */
export const OntologyEntityTypesWireResponse = ApiSuccessEnvelope(
  z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      source: z.string(),
    }),
  ),
);

// OKM lines 269-287 — GraphConnectivityEndpointResponse
/**
 * Wire-shape envelope for `/graph/connectivity`. Verbatim from OKM
 * rest-contract.test.ts:269-287.
 */
export const GraphConnectivityEndpointResponse = ApiSuccessEnvelope(
  z.object({
    totalNodes: z.number().int().nonnegative(),
    totalEdges: z.number().int().nonnegative(),
    componentCount: z.number().int().nonnegative(),
    connectivity: z.number(),
    trueOrphans: z.array(
      z.object({
        nodeId: z.string(),
        name: z.string(),
        entityType: z.string(),
        layer: z.string(),
        degree: z.number().int().nonnegative(),
      }),
    ),
    islandNodes: z.array(z.unknown()),
    components: z.array(z.unknown()),
  }),
);

// ============================================================================
// §3 — HTTP-default aliases (unprefixed symbols → wire shape)
// ============================================================================
//
// Consumers importing without the `Wire` suffix get the wire shape (the
// contract that crosses the HTTP boundary). This is the right default because
// km-core's API surface IS the HTTP surface — domain consumers use the
// explicit `*Domain` suffix.

/** HTTP-default Entity = the wire shape. */
export const EntitySchema = EntityWireSchema;
/** HTTP-default Relation = the wire shape. */
export const RelationSchema = RelationWireSchema;
/** HTTP-default Stats = the wire shape. */
export const StatsSchema = StatsWireSchema;

// --- Response envelopes (canonical endpoints) ------------------------------

/**
 * Pre-composed response envelopes for the canonical endpoints. Plans 06/09
 * import these by name; the regenerated OKM fixtures (Plan 09) validate
 * against them.
 */
export const EntityResponse = ApiSuccessEnvelope(EntityWireSchema);
export const EntitiesEndpointResponse = ApiSuccessEnvelope(z.array(EntityWireSchema));
export const RelationResponse = ApiSuccessEnvelope(RelationWireSchema);
export const RelationsEndpointResponse = ApiSuccessEnvelope(z.array(RelationWireSchema));
export const StatsResponse = ApiSuccessEnvelope(StatsWireSchema);

// ============================================================================
// §4 — Inferred TS types
// ============================================================================
//
// Exporting z.infer<typeof ...> aliases lets consumers (e.g. OKM
// rest-contract.test.ts in Plan 09; Plan 06 router internals) get TypeScript
// types "for free" without re-declaring interfaces.

export type ProvenanceStamp = z.infer<typeof ProvenanceStampSchema>;

// Wire-shape inferred types — what crosses HTTP.
export type EntityWire = z.infer<typeof EntityWireSchema>;
export type RelationWire = z.infer<typeof RelationWireSchema>;
export type StatsWire = z.infer<typeof StatsWireSchema>;
export type EntityProvenance = z.infer<typeof EntityProvenanceSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type Cluster = z.infer<typeof ClusterSchema>;
export type RcaConfidence = z.infer<typeof RcaConfidenceSchema>;
export type RcaChainStep = z.infer<typeof RcaChainStepSchema>;
export type RcaMatch = z.infer<typeof RcaMatchSchema>;

// Domain-shape inferred types — for in-process rich consumers.
export type EntityDomain = z.infer<typeof EntityDomainSchema>;
export type RelationDomain = z.infer<typeof RelationDomainSchema>;

// HTTP-default type aliases (what consumers get when importing `Entity`,
// `Relation`, `Stats` without the `Wire` suffix — they get the wire shape).
export type Entity = EntityWire;
export type Relation = RelationWire;
export type Stats = StatsWire;

export type EntityResponseT = z.infer<typeof EntityResponse>;
export type EntitiesEndpointResponseT = z.infer<typeof EntitiesEndpointResponse>;
export type RelationResponseT = z.infer<typeof RelationResponse>;
export type RelationsEndpointResponseT = z.infer<typeof RelationsEndpointResponse>;
export type StatsResponseT = z.infer<typeof StatsResponse>;
export type SearchEndpointResponseT = z.infer<typeof SearchEndpointResponse>;
export type ClustersEndpointResponseT = z.infer<typeof ClustersEndpointResponse>;
export type ExportEndpointResponseT = z.infer<typeof ExportEndpointResponse>;
export type OntologyClassesWireResponseT = z.infer<typeof OntologyClassesWireResponse>;
export type OntologyEntityTypesWireResponseT = z.infer<
  typeof OntologyEntityTypesWireResponse
>;
export type GraphConnectivityEndpointResponseT = z.infer<
  typeof GraphConnectivityEndpointResponse
>;
export type RcaLookupEndpointResponseT = z.infer<typeof RcaLookupEndpointResponse>;

// Phase 44 — km-core canonical REST contract (Zod schemas + inferred TS types).
//
// SOURCE: Zod block lifted VERBATIM from OKM `tests/integration/rest-contract.test.ts:94-167`,
// as identified by 44-RESEARCH.md § Pattern 2 (lines 207-251) and 44-PATTERNS.md
// § `lib/km-core/src/api/contracts.ts` (lines 165-209 — "Pattern deviations: None.
// Adopt RESEARCH Pattern 2 verbatim. Export `z.infer<>` types for consumer convenience.").
//
// CONTEXT C-2: "OKM response shapes verbatim, codified as Zod" — Phase 44 lifts the
// schemas from OKM test-only into shipped km-core artifacts under
// `@fwornle/km-core/api/contracts`. Plans 06/07/08/09 implement against these
// schemas; the regenerated OKM fixtures (Plan 09) validate against them without
// re-declaration.
//
// Field coverage:
//   - Phase 39 entity shape (D-30..D-33): id, name, entityType, layer, description,
//     createdAt, updatedAt, metadata, validFrom, validUntil, supersedes, createdBy,
//     lastConfirmedBy, confirmationCount.
//   - Phase 41 legacyId (D-13): origin-system bridge { system: 'A'|'B'|'C', id: string }.
//   - Phase 42 embedding (D-52): optional number[] (Qdrant rebuild source-of-truth).
//   - Phase 38 ontology surface: OntologyClassSchema (registry response shape).
//   - OKM /api/stats response: StatsSchema.
//
// Additional canonical schemas beyond OKM's lift (per Plan 44-03 <action>):
//   RelationSchema, OntologyClassSchema, StatsSchema, and corresponding
//   ApiSuccessEnvelope-wrapped response envelopes. These are part of the
//   canonical contract per CONTEXT C-2 even though the Wave 0 RED test
//   `tests/unit/contracts.test.ts` only directly asserts EntitySchema.
//
// Consumers import:
//   import { EntitySchema, ApiSuccessEnvelope } from '@fwornle/km-core/api/contracts';
//   import type { Entity, Relation, EntityResponse } from '@fwornle/km-core/api/contracts';
//
// no-console-log: schemas are pure data — no diagnostic emission. Errors surface
// via Zod's `.parse()` throw / `.safeParse()` result-object path; Plan 06's
// router wraps these in the safe `{success:false, error:<msg>}` envelope (V7
// control per 44-RESEARCH § Threat T-44-03-02).
//
// no-parallel-versions (lib/km-core/CLAUDE.md): file is EXACTLY `contracts.ts`.
// No `contracts-v2.ts`, `enhanced-contracts.ts`, etc. Edit this file in place
// when extending.

import { z } from 'zod';

// --- Sub-schemas -----------------------------------------------------------

/**
 * Provenance stamp: tracks which LLM run created or confirmed an entity.
 * Phase 39 D-30 — non-optional fields when present; the Entity may omit the
 * stamp entirely (legacy Phase 37 entities) but a stamp object always carries
 * all four fields.
 */
export const ProvenanceStampSchema = z.object({
  provider: z.string(),
  model: z.string(),
  runId: z.string(),
  timestamp: z.string(),
});

// --- Entity ----------------------------------------------------------------

/**
 * Canonical Entity wire shape. Mirrors `lib/km-core/src/types/entity.ts` Entity
 * field-for-field with the following Zod-specific notes:
 *   - `id` is a plain string at the wire level (the EntityId brand is a
 *     compile-time-only construct; over JSON it is the raw UUIDv7 string).
 *   - `metadata` uses `z.record(z.string(), z.unknown())` — open-ended bag.
 *   - `layer` is the Phase 39 evidence/pattern enum.
 *   - `legacyId.system` is the Phase 41 'A'|'B'|'C' enum.
 *   - `embedding` is Phase 42's optional number[] (no dimension enforcement
 *     here — Qdrant collection contract owns the dimension invariant).
 */
export const EntitySchema = z.object({
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

// --- Relation --------------------------------------------------------------

/**
 * Canonical Relation wire shape. Plan 06's router emits this on
 * `GET /relations` and accepts it on `POST /relations`.
 *
 * Field mapping vs `src/types/entity.ts` Relation:
 *   - `from` / `to` are wire strings (EntityId brand stripped over JSON).
 *   - `relationType` mirrors the in-process `type` field — kept under the
 *     `relationType` name on the wire to match OKM's existing payload key
 *     (CONTEXT C-2 verbatim contract; consumers / fixtures already use
 *     `relationType`).
 *   - `key` is OKM's deterministic edge key (`<from>|<to>|<type>`); optional
 *     on POST (router synthesises), required on GET responses.
 *   - `createdAt` is the ISO timestamp (Phase 39 stamping).
 *   - `metadata` is the open-ended bag.
 */
export const RelationSchema = z.object({
  from: z.string(),
  to: z.string(),
  key: z.string().optional(),
  relationType: z.string(),
  createdAt: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// --- Ontology --------------------------------------------------------------

/**
 * Ontology class wire shape. Plan 06's router emits this on
 * `GET /ontology/classes` and `GET /ontology/schema/:className`.
 *
 * Mirrors Phase 38 `ResolvedClass` (registry-flattened with `extends` chains
 * resolved). `properties` and `relationships` are open-ended bags keyed by
 * the property/relation name; concrete shapes are owned by the registry.
 */
export const OntologyClassSchema = z.object({
  name: z.string(),
  parent: z.string().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  relationships: z.record(z.string(), z.array(z.string())).optional(),
});

// --- Stats -----------------------------------------------------------------

/**
 * Stats wire shape. Plan 06's router emits this on `GET /stats`. Mirrors
 * OKM's existing `/api/stats` response (CONTEXT C-2 verbatim contract).
 */
export const StatsSchema = z.object({
  entityCount: z.number().int().nonnegative(),
  relationCount: z.number().int().nonnegative(),
  ontologyClasses: z.number().int().nonnegative(),
  domainsActive: z.array(z.string()),
});

// --- Success envelope ------------------------------------------------------

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
export const ApiSuccessEnvelope = (data: z.ZodTypeAny) =>
  z.object({ success: z.literal(true), data });

// --- Response envelopes (canonical endpoints) ------------------------------

/**
 * Pre-composed response envelopes for the canonical endpoints. Plans 06/09
 * import these by name; the regenerated OKM fixtures (Plan 09) validate
 * against them.
 */
export const EntityResponse = ApiSuccessEnvelope(EntitySchema);
export const EntitiesEndpointResponse = ApiSuccessEnvelope(z.array(EntitySchema));
export const RelationResponse = ApiSuccessEnvelope(RelationSchema);
export const RelationsEndpointResponse = ApiSuccessEnvelope(z.array(RelationSchema));
export const OntologyClassResponse = ApiSuccessEnvelope(OntologyClassSchema);
export const OntologyClassesEndpointResponse = ApiSuccessEnvelope(
  z.array(OntologyClassSchema),
);
export const StatsResponse = ApiSuccessEnvelope(StatsSchema);

// --- Inferred TS types -----------------------------------------------------
//
// Exporting z.infer<typeof ...> aliases lets consumers (e.g. OKM
// rest-contract.test.ts in Plan 09; Plan 06 router internals) get TypeScript
// types "for free" without re-declaring interfaces. Per CONTEXT C-2 these are
// part of the shipped contract.

export type ProvenanceStamp = z.infer<typeof ProvenanceStampSchema>;
export type Entity = z.infer<typeof EntitySchema>;
export type Relation = z.infer<typeof RelationSchema>;
export type OntologyClass = z.infer<typeof OntologyClassSchema>;
export type Stats = z.infer<typeof StatsSchema>;

export type EntityResponseT = z.infer<typeof EntityResponse>;
export type EntitiesEndpointResponseT = z.infer<typeof EntitiesEndpointResponse>;
export type RelationResponseT = z.infer<typeof RelationResponse>;
export type RelationsEndpointResponseT = z.infer<typeof RelationsEndpointResponse>;
export type OntologyClassResponseT = z.infer<typeof OntologyClassResponse>;
export type OntologyClassesEndpointResponseT = z.infer<
  typeof OntologyClassesEndpointResponse
>;
export type StatsResponseT = z.infer<typeof StatsResponse>;

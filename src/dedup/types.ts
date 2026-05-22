// Dedup-API public types (D-44 three layer interfaces + DedupResult).
//
// All shapes are net-new to KM-Core. The interfaces enforce the D-44
// short-circuit contract: each layer exposes a typed `threshold` plus
// async `match(entity, candidates) => MatchResult`. Layers are independent
// types so per-layer mocking in tests is type-safe.
//
// SOURCE: shape derived from OKM
//   _work/rapid-automations/integrations/operational-knowledge-management/
//   src/ingestion/deduplicator.ts (lines 24-36 — DeduplicationResult,
//   DedupMatch)
// with 2 deltas applied:
//
//   1. D-44 splits OKM's single `DeduplicationResult` into per-layer
//      `MatchResult` (one layer's verdict) plus aggregated `DedupResult`
//      (the LayeredDeduplicator-level verdict with `matchedLayer`
//      discriminator and `allLayerResults` audit trail).
//
//   2. Adds `matchedLayer` discriminator + `allLayerResults` so that
//      `shortCircuit: false` calibration runs can record every layer's
//      verdict even after the first match (per 40-CONTEXT D-44).
//
// Per 40-CONTEXT D-46 the `candidates` parameter on every `match()` call
// is an ontologyClass-scoped, active-only-by-default pool sourced by the
// pipeline before each dedup call. Layer impls do NOT re-filter.
//
// Client interfaces (`EmbeddingClient`, `LLMClient`) are co-located with
// their matcher impls (Plans 40-03 + 40-04) per 40-PATTERNS offset 511-516
// and Warning #4 — the interface lives in the same file as the class that
// types it. The type-only re-exports below give consumers reaching the
// dedup sub-barrel (`@fwornle/km-core/dedup`) a complete type surface
// without having to import deeply into individual matcher modules.

import type { Entity } from '../types/entity.js';

/**
 * Per-layer dedup verdict (D-44). Returned by every layer's `match()`.
 *
 * - `matched: true` ⇒ `survivor` is defined and `confidence` is the
 *   layer-specific similarity score.
 * - `matched: false` ⇒ `survivor` is undefined; `confidence` is still
 *   populated (typically 0 or the best below-threshold score the layer
 *   saw) so calibration runs (`shortCircuit: false`) can record near-
 *   misses.
 */
export interface MatchResult {
  /** Did this layer find a confident match against `candidates`? */
  matched: boolean;
  /** Best candidate when `matched: true`. */
  survivor?: Entity;
  /** Similarity score in the layer's native metric (Jaccard / cosine / LLM). */
  confidence: number;
}

/**
 * Exact-name layer (D-44). Concrete impl: `JaccardNameMatcher` (Plan
 * 40-02). Threshold default 0.85 per 40-CONTEXT (tunable per ctor opt).
 *
 * `candidates` is ontologyClass-scoped, active-only-by-default — sourced
 * by the pipeline via `store.findByOntologyClass(entity.ontologyClass)`
 * per D-46.
 */
export interface ExactNameLayer {
  /** D-44 per-layer threshold; layer matches when score ≥ threshold. */
  readonly threshold: number;
  /** Compare `entity` against `candidates` (D-46 class-scoped pool). */
  match(entity: Entity, candidates: Entity[]): Promise<MatchResult>;
}

/**
 * Embedding-cosine layer (D-44). Concrete impl: `CosineEmbeddingMatcher`
 * (Plan 40-03). Threshold default 0.90 per 40-CONTEXT (tunable per ctor
 * opt; A's surface uses 0.93 / 0.88 — see 40-RESEARCH).
 *
 * Implementations receive a caller-supplied `EmbeddingClient` via their
 * ctor opts; the layer interface itself is client-agnostic.
 *
 * `candidates` is ontologyClass-scoped per D-46.
 */
export interface EmbeddingLayer {
  /** D-44 per-layer threshold; layer matches when score ≥ threshold. */
  readonly threshold: number;
  /** Compare `entity` against `candidates` (D-46 class-scoped pool). */
  match(entity: Entity, candidates: Entity[]): Promise<MatchResult>;
}

/**
 * LLM-semantic layer (D-44). Concrete impl: `LLMSemanticMatcher` (Plan
 * 40-04). Threshold default 0.70 per 40-CONTEXT (tunable per ctor opt).
 *
 * Implementations receive a caller-supplied `LLMClient` via their ctor
 * opts; the layer interface itself is client-agnostic.
 *
 * `candidates` is ontologyClass-scoped per D-46.
 */
export interface LLMSemanticLayer {
  /** D-44 per-layer threshold; layer matches when score ≥ threshold. */
  readonly threshold: number;
  /** Compare `entity` against `candidates` (D-46 class-scoped pool). */
  match(entity: Entity, candidates: Entity[]): Promise<MatchResult>;
}

/**
 * Aggregated dedup verdict from `LayeredDeduplicator.dedup()` (D-44).
 *
 * - `matched: true` ⇒ at least one layer matched above its threshold;
 *   `survivor`, `matchedLayer`, and `confidence` reflect the winning
 *   layer (the first matched layer when `shortCircuit: true`).
 * - `matched: false` ⇒ no layer matched; `survivor` / `matchedLayer` /
 *   `confidence` are undefined; `allLayerResults` still records each
 *   layer's verdict.
 * - `allLayerResults` — audit trail: one entry per layer that actually
 *   ran (omitted layers / short-circuited layers contribute no entry).
 *
 * Source: 40-RESEARCH Example 1 lines 312-326.
 */
export interface DedupResult {
  /** True when any layer matched above its threshold. */
  matched: boolean;
  /** Survivor entity when matched (writer-side supersession target). */
  survivor?: Entity;
  /** Which layer's verdict won (when `matched: true`). */
  matchedLayer?: 'exactName' | 'embedding' | 'llmSemantic';
  /** Confidence of the winning layer (when `matched: true`). */
  confidence?: number;
  /** Audit trail — one entry per layer that ran. */
  allLayerResults: Array<{
    layer: string;
    matched: boolean;
    survivor?: Entity;
    confidence: number;
  }>;
}

// Phase 40 Plan 07 — type-only re-exports for the dedup sub-barrel surface.
// Co-located with matchers per 40-PATTERNS offset 511-516; the runtime
// classes stay in their own files. Consumers reach these via either
// `@fwornle/km-core/dedup` (sub-path) or `@fwornle/km-core` (root barrel).
export type { EmbeddingClient } from './CosineEmbeddingMatcher.js';
export type { LLMClient } from './LLMSemanticMatcher.js';

// Phase 40 Plan 03 (DEDUP-01, EmbeddingLayer): embedding-cosine dedup
// layer (layer 2 of 3 per D-44 declared order).
//
// SOURCE: cosine math is a VERBATIM port from A's existing dedup script
//   /Users/Q284340/Agentic/coding/scripts/dedup-insights-by-embedding.js
//   lines 56-64 (the `cosine(a, b)` function).
// Threshold semantics derive from A's three production thresholds
// (`dedup-insights-by-embedding.js:39` = 0.93 for insight-dedup;
// `ObservationConsolidator.js:36` = 0.88 for insight-merge-gating;
// `ObservationConsolidator.js:73` = 0.97 for digest dedup) — see
// 40-RESEARCH Pitfall 4 + A2.
//
// DELTAS applied vs the source:
//
//   1. Implements `EmbeddingLayer` (Plan 40-01 dedup/types.ts) so the
//      result type is the framework's structured `MatchResult` rather than
//      a bare scalar similarity. The layer interface mandates an async
//      `match(entity, candidates) => MatchResult` (D-44 contract).
//
//   2. `threshold` is a ctor option with default 0.90 — chosen per
//      40-RESEARCH A2 as a single-surface starting point BETWEEN A's
//      insight-dedup (0.93) and insight-merge-gating (0.88). Callers MUST
//      tune per surface (Pitfall 4 — short identifiers cluster higher
//      than paragraph embeddings). See the threshold field JSDoc.
//
//   3. `EmbeddingClient` is a caller-supplied dependency interface owned
//      by this file. km-core takes no Qdrant dependency; Phase 41 (A
//      INT-01) and Phase 42 (B INT-02) wire their concrete clients. The
//      CONTEXT.md deferred-idea "Cross-batch state for embedding layer
//      (Qdrant integration)" lives entirely in the caller.
//
//   4. `textOf` is a caller-controllable mapping from `Entity` to the
//      string fed to `client.embed()`. Default is `${name}\n\n${description}`
//      trimmed — mirrors A's `ObservationConsolidator.js:243` shape.
//      Callers override for surfaces where a different text serializes
//      better (e.g., short-name-only for code identifiers).
//
//   5. no-console-log: this matcher emits ZERO diagnostics. The framework
//      observability hook is `IngestPipeline.onPhase` at the outer pipeline
//      layer; per-layer diagnostics would double-log and crowd the
//      callback. If a layer NEEDS to warn (e.g., LLMSemanticMatcher on
//      JSON parse failure), it uses `process.stderr.write(...)` — never
//      `console.*` per repo no-console-log rule.

import type { Entity } from '../types/entity.js';
import type { EmbeddingLayer, MatchResult } from './types.js';

/**
 * Caller-supplied embedding service. Phase 41 wires this to A's Qdrant;
 * Phase 42 wires this to B's embedding store. A `search()` overload may
 * be added by future plans for fast-path candidate retrieval that avoids
 * round-tripping every candidate text through `embed()` — for v0.1 the
 * matcher just calls `embed()` for the entity + all candidates in
 * parallel.
 */
export interface EmbeddingClient {
  embed(text: string): Promise<Float32Array | number[]>;
}

/** Ctor options for `CosineEmbeddingMatcher` (D-14 options-object). */
export interface CosineEmbeddingMatcherOpts {
  /** Caller-supplied embedding service (see `EmbeddingClient`). */
  client: EmbeddingClient;
  /**
   * Similarity threshold above which `match()` returns
   * `{ matched: true, ... }`.
   *
   * **Default 0.90** is a single-surface starting point between A's
   * insight-dedup threshold (0.93) and insight-merge-gate (0.88). Callers
   * MUST tune per their embedding model + content type — short
   * identifiers cluster higher than paragraph embeddings (MiniLM-L6-v2
   * single-project docs cluster 0.75-0.82 per A's
   * `retrieval-service.js:38-45` commentary; see 40-RESEARCH Pitfall 4).
   */
  threshold?: number;
  /**
   * Map an Entity to the text fed to `client.embed()`. Default is
   * `${e.name}\n\n${e.description ?? ''}`.trim() — mirrors A's
   * `ObservationConsolidator.js:243` shape. Override for surfaces where
   * a different serialization clusters better (e.g., bag-of-fields,
   * name-only).
   */
  textOf?: (e: Entity) => string;
}

/**
 * Embedding-cosine dedup layer (D-44 layer 2 of 3). Computes cosine
 * similarity between `entity` and every `candidates[i]` using a
 * caller-supplied `EmbeddingClient`, returns the best above-threshold
 * candidate.
 *
 * Self-match guard: skips `candidates[i]` where `id === entity.id` per
 * 40-RESEARCH Example 3 line 414. This is the same guard B uses in its
 * Jaccard layer (Plan 40-02) and OKM uses in its LLM layer.
 *
 * D-46: caller (the pipeline, not this matcher) pre-filters `candidates`
 * to the same ontologyClass + active-only via
 * `store.findByOntologyClass(entity.ontologyClass)`. This matcher does
 * NOT re-filter.
 */
export class CosineEmbeddingMatcher implements EmbeddingLayer {
  readonly threshold: number;
  private client: EmbeddingClient;
  private textOf: (e: Entity) => string;

  constructor(opts: CosineEmbeddingMatcherOpts) {
    this.client = opts.client;
    this.threshold = opts.threshold ?? 0.90;
    this.textOf =
      opts.textOf ?? ((e) => `${e.name}\n\n${e.description ?? ''}`.trim());
  }

  async match(entity: Entity, candidates: Entity[]): Promise<MatchResult> {
    if (candidates.length === 0) {
      return { matched: false, confidence: 0 };
    }
    const [entityVec, ...candidateVecs] = await Promise.all([
      this.client.embed(this.textOf(entity)),
      ...candidates.map((c) => this.client.embed(this.textOf(c))),
    ]);
    let best: { candidate: Entity; score: number } | null = null;
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i].id === entity.id) continue;
      const score = cosine(entityVec, candidateVecs[i]);
      if (score >= this.threshold && (!best || score > best.score)) {
        best = { candidate: candidates[i], score };
      }
    }
    return best
      ? { matched: true, survivor: best.candidate, confidence: best.score }
      : { matched: false, confidence: 0 };
  }
}

/**
 * Verbatim port of A's cosine helper from
 * `scripts/dedup-insights-by-embedding.js:56-64`. Pure function, no
 * allocations beyond locals, returns 0 when either vector is zero-length
 * or zero-norm.
 */
function cosine(
  a: Float32Array | number[],
  b: Float32Array | number[],
): number {
  let dot = 0,
    na = 0,
    nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

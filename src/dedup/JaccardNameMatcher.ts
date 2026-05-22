// Phase 40 (DEDUP-01): JaccardNameMatcher — exact-name layer impl.
//
// SOURCE: lifted from B
//   integrations/mcp-server-semantic-analysis/src/agents/deduplication.ts
//   lines 436-445 (calculateStringSimilarity)
// with 2 deltas applied:
//
//   1. Implements the ExactNameLayer interface (D-44) — match()
//      returns { matched, survivor?, confidence } instead of a bare number.
//
//   2. Threshold becomes a ctor opt (D-44 per-layer threshold convention)
//      with default 0.85 (matches B's similarityConfig.similarityThreshold
//      in deduplication.ts:61 per 40-RESEARCH A1).
//
// Layer 1 of the 3-layer dedup pipeline (D-44 declared order). Cheapest
// layer — runs first; short-circuits when matched per default.
//
// no-console-log: matcher emits no diagnostics; all logging stays at the
// caller (LayeredDeduplicator / IngestPipeline level).

import type { Entity } from '../types/entity.js';
import type { ExactNameLayer, MatchResult } from './types.js';

/**
 * Ctor opts for {@link JaccardNameMatcher}.
 *
 * `threshold` defaults to 0.85 — B's production
 * `similarityConfig.similarityThreshold` value per 40-RESEARCH A1. Tune
 * lower for recall-leaning surfaces; higher for precision-leaning ones.
 */
export interface JaccardNameMatcherOpts {
  threshold?: number;
}

/**
 * Exact-name dedup layer (D-44, layer 1 of 3). Uses Jaccard word-set
 * similarity over `entity.name` lowercased + whitespace-split.
 *
 * Pure transform: no `this` state beyond ctor opts, no I/O, no mutation
 * of `entity` or `candidates`. Per CR-02 (40-REVIEW.md), no self-id
 * guard — exact id collision IS the same logical entity (legacy-id
 * re-extraction path) and IS the match dedup must catch. Self-write
 * protection is the store's job.
 */
export class JaccardNameMatcher implements ExactNameLayer {
  readonly threshold: number;

  constructor(opts: JaccardNameMatcherOpts = {}) {
    this.threshold = opts.threshold ?? 0.85;
  }

  async match(entity: Entity, candidates: Entity[]): Promise<MatchResult> {
    let best: { candidate: Entity; score: number } | null = null;
    // CR-02 fix (40-REVIEW.md): no self-id guard. By D-46 (active-only
    // candidate pool), an exact id collision means the same logical
    // entity — which IS what dedup is meant to catch (legacy-id
    // re-extraction). Self-write protection is the store's job, not
    // the matcher's. See 40-REVIEW.md CR-02 + 40-VERIFICATION.md gap #2.
    for (const candidate of candidates) {
      const score = jaccard(entity.name, candidate.name);
      if (score >= this.threshold && (!best || score > best.score)) {
        best = { candidate, score };
      }
    }
    return best
      ? { matched: true, survivor: best.candidate, confidence: best.score }
      : { matched: false, confidence: 0 };
  }
}

/**
 * Verbatim port of B's `calculateStringSimilarity`
 * (integrations/mcp-server-semantic-analysis/src/agents/deduplication.ts
 * lines 436-445). Jaccard similarity of lowercased word sets.
 */
function jaccard(a: string, b: string): number {
  const words1 = new Set(a.toLowerCase().split(/\s+/));
  const words2 = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...words1].filter((w) => words2.has(w)));
  const union = new Set([...words1, ...words2]);
  return union.size > 0 ? intersection.size / union.size : 0;
}

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
 * of `entity` or `candidates`. Identity guard via `candidate.id === entity.id`
 * prevents self-match against the entity's own row in the candidate pool.
 */
export class JaccardNameMatcher implements ExactNameLayer {
  readonly threshold: number;

  constructor(opts: JaccardNameMatcherOpts = {}) {
    this.threshold = opts.threshold ?? 0.85;
  }

  async match(entity: Entity, candidates: Entity[]): Promise<MatchResult> {
    let best: { candidate: Entity; score: number } | null = null;
    for (const candidate of candidates) {
      if (candidate.id === entity.id) continue; // never match self
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

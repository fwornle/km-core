// Universal test fakes for Phase 40 pipeline + dedup tests.
//
// EmbeddingClient + LLMClient fakes are NOT in this file — they ship
// co-located with their respective matchers as `_helpers/fakes-embedding.ts`
// (Plan 40-03) and `_helpers/fakes-llm.ts` (Plan 40-04). This keeps fakes.ts
// compilable from Plan 01 onward without forward references to Plans 03 + 04's
// still-uncreated source files (Warning #4 fix from 40-01-PLAN <objective>).
//
// File-name convention: leading underscore in `_helpers/` + `fakes.ts` (no
// `.test.` substring) keeps vitest's default test discovery from picking it
// up as a test file (`include: ['tests/**/*.test.ts']` in vitest.config.ts).
//
// Exports (5 universal — used by Plans 02, 04, 05, 06a):
//   - `mkEntity(overrides?)` — Entity builder mirroring
//     `tests/unit/segments-merge.test.ts:20-32`, with a deterministic
//     UUIDv7-shaped id + 2026-05-21T00:00:00.000Z timestamps.
//   - `makeFakeExtractor(entities)` — Extractor factory returning a
//     `vi.fn()`-backed `extract()` so callers can assert call args.
//   - `makeFakeSynthesizer()` — Synthesizer factory returning a `vi.fn()`.
//   - `makeLayerStub({ kind, threshold?, willMatch?, survivor?, confidence? })`
//     — discriminated factory returning a typed stub satisfying
//     ExactNameLayer | EmbeddingLayer | LLMSemanticLayer.
//   - `PROV` — canonical test-side ProvenanceStamp constant for use as
//     `IngestOpts.provenance` in pipeline tests.

import { vi } from 'vitest';
import type { Entity, ProvenanceStamp } from '../../../src/index.js';
import type { EntityId } from '../../../src/index.js';
import type {
  Extractor,
  Synthesizer,
} from '../../../src/pipeline/types.js';
import type {
  ExactNameLayer,
  EmbeddingLayer,
  LLMSemanticLayer,
  MatchResult,
} from '../../../src/dedup/types.js';

/**
 * Canonical test-side ProvenanceStamp constant. Pass as
 * `pipeline.ingest(text, { provenance: PROV })` in pipeline tests.
 */
export const PROV: ProvenanceStamp = {
  provider: 'test',
  model: 'test-model',
  runId: 'phase-40-test',
  timestamp: '2026-05-21T00:00:00.000Z',
};

/**
 * Entity builder for Phase 40 tests. Deterministic id + timestamps; tests
 * override via the `overrides` spread. Mirrors
 * `tests/unit/segments-merge.test.ts:20-32` with an `ontologyClass` field
 * added so dedup tests can exercise D-46's class-scoped candidate pool.
 */
export function mkEntity(overrides?: Partial<Entity>): Entity {
  return {
    id: '0192a000-0000-7000-8000-000000000000' as EntityId,
    name: 'TestEntity',
    entityType: 'Component',
    ontologyClass: 'Component',
    layer: 'evidence',
    description: '',
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}

/**
 * Extractor stub. Returns `{ extract: vi.fn(async () => entities) }` so
 * pipeline tests can assert `expect(extractor.extract).toHaveBeenCalledWith
 * (text, domain)` and control the extracted batch precisely.
 */
export function makeFakeExtractor(entities: Entity[]): Extractor {
  return {
    extract: vi.fn(async (_text: string, _domain?: string) => entities),
  };
}

/**
 * Synthesizer stub. Returns `{ synthesize: vi.fn(async () => undefined) }`
 * so pipeline tests can assert the synthesize stage fired (or didn't, when
 * `IngestOpts.skipStages` includes `'synthesize'`).
 */
export function makeFakeSynthesizer(): Synthesizer {
  return {
    synthesize: vi.fn(async (_survivorIds, _opts) => undefined),
  };
}

/**
 * Discriminated layer-stub factory. The `kind` opt selects which D-44
 * layer interface the returned stub satisfies; the structural shape is
 * identical across all three layers, so the discrimination is purely
 * type-narrowing for test ergonomics.
 *
 * Defaults: `threshold: 0.9`, `willMatch: false`. When `willMatch: true`
 * the caller MUST supply a `survivor`; the default `confidence` is 0.95.
 *
 * Used by Plan 05's LayeredDeduplicator tests to drive each layer's
 * match() return value deterministically without hitting real Jaccard /
 * cosine / LLM impls.
 */
export function makeLayerStub(opts: {
  kind: 'exactName';
  threshold?: number;
  willMatch?: boolean;
  survivor?: Entity;
  confidence?: number;
}): ExactNameLayer;
export function makeLayerStub(opts: {
  kind: 'embedding';
  threshold?: number;
  willMatch?: boolean;
  survivor?: Entity;
  confidence?: number;
}): EmbeddingLayer;
export function makeLayerStub(opts: {
  kind: 'llmSemantic';
  threshold?: number;
  willMatch?: boolean;
  survivor?: Entity;
  confidence?: number;
}): LLMSemanticLayer;
export function makeLayerStub(opts: {
  kind: 'exactName' | 'embedding' | 'llmSemantic';
  threshold?: number;
  willMatch?: boolean;
  survivor?: Entity;
  confidence?: number;
}): ExactNameLayer | EmbeddingLayer | LLMSemanticLayer {
  const threshold = opts.threshold ?? 0.9;
  const willMatch = opts.willMatch ?? false;
  const confidence = opts.confidence ?? 0.95;
  return {
    threshold,
    match: vi.fn(async (_entity: Entity, _candidates: Entity[]): Promise<MatchResult> =>
      willMatch
        ? { matched: true, survivor: opts.survivor!, confidence }
        : { matched: false, confidence: 0 },
    ),
  };
}

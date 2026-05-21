// Phase 40 Plan 03 (DEDUP-01, EmbeddingLayer): CosineEmbeddingMatcher unit
// tests. Wave 1 RED state: `CosineEmbeddingMatcher` is created in Task 2 of
// this plan; until then this file fails with "Cannot find module" against
// '../../src/dedup/CosineEmbeddingMatcher.js'.
//
// Test names + structure derived from 40-PATTERNS.md offset 719-747.
//
// Imports the co-located fake `makeFakeEmbeddingClient` from
// `_helpers/fakes-embedding.ts` (this plan's new file) AND the universal
// `mkEntity` from `_helpers/fakes.ts` (Plan 40-01).

import { describe, test, expect } from 'vitest';
import {
  CosineEmbeddingMatcher,
  type EmbeddingClient,
} from '../../src/dedup/CosineEmbeddingMatcher.js';
import { mkEntity } from './_helpers/fakes.js';
import { makeFakeEmbeddingClient } from './_helpers/fakes-embedding.js';
import type { EntityId } from '../../src/index.js';

// Constants for deterministic UUIDv7-shaped distinct ids. UUIDv7 layout:
// xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx (14th hex digit MUST be '7').
const ID_ENTITY = '0192a000-0000-7000-8000-000000000000' as EntityId;
const ID_C1 = '0192a000-0000-7000-8000-000000000001' as EntityId;
const ID_C2 = '0192a000-0000-7000-8000-000000000002' as EntityId;
const ID_C3 = '0192a000-0000-7000-8000-000000000003' as EntityId;

// Helper: build the second component of a 2D unit vector with a chosen
// cosine against [1, 0]. cosine([1,0], [x, y]) = x when ||[x,y]|| = 1.
// So pass cosine ∈ [0, 1] and get back [cos, sqrt(1-cos²)] — a unit
// vector with the exact cosine requested against [1, 0].
function unitAtCosine(cos: number): [number, number] {
  return [cos, Math.sqrt(1 - cos * cos)];
}

describe('CosineEmbeddingMatcher', () => {
  test('returns matched: false when candidates is empty', async () => {
    const client = makeFakeEmbeddingClient();
    const matcher = new CosineEmbeddingMatcher({ client });
    const result = await matcher.match(mkEntity({ name: 'EntityA' }), []);
    expect(result.matched).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.survivor).toBeUndefined();
  });

  test('cosine 1.0 for identical embeddings → matched with confidence 1.0', async () => {
    const embeddings = new Map<string, number[]>([
      ['EntityA', [1, 0, 0]],
      ['EntityB', [1, 0, 0]],
    ]);
    const client = makeFakeEmbeddingClient({ embeddings });
    const matcher = new CosineEmbeddingMatcher({ client });
    const entity = mkEntity({ id: ID_ENTITY, name: 'EntityA' });
    const candidate = mkEntity({ id: ID_C1, name: 'EntityB' });
    const result = await matcher.match(entity, [candidate]);
    expect(result.matched).toBe(true);
    expect(result.survivor?.id).toBe(ID_C1);
    expect(result.confidence).toBeCloseTo(1.0, 10);
  });

  test('cosine below threshold returns matched: false', async () => {
    // Orthogonal vectors: cosine = 0 (well below default 0.90).
    const embeddings = new Map<string, number[]>([
      ['EntityA', [1, 0, 0]],
      ['EntityB', [0, 1, 0]],
    ]);
    const client = makeFakeEmbeddingClient({ embeddings });
    const matcher = new CosineEmbeddingMatcher({ client });
    const result = await matcher.match(
      mkEntity({ id: ID_ENTITY, name: 'EntityA' }),
      [mkEntity({ id: ID_C1, name: 'EntityB' })],
    );
    expect(result.matched).toBe(false);
    expect(result.survivor).toBeUndefined();
  });

  test('threshold default 0.90 — score 0.89 returns no-match, score 0.91 matches', async () => {
    // Entity at [1, 0]; one candidate at cosine 0.89 (below), one at 0.91 (above).
    const embeddings = new Map<string, number[]>([
      ['EntityA', [1, 0]],
      ['Below', unitAtCosine(0.89)],
      ['Above', unitAtCosine(0.91)],
    ]);
    const clientLow = makeFakeEmbeddingClient({ embeddings });
    const matcherLow = new CosineEmbeddingMatcher({ client: clientLow });
    const lowResult = await matcherLow.match(
      mkEntity({ id: ID_ENTITY, name: 'EntityA' }),
      [mkEntity({ id: ID_C1, name: 'Below' })],
    );
    expect(lowResult.matched).toBe(false);

    const clientHigh = makeFakeEmbeddingClient({ embeddings });
    const matcherHigh = new CosineEmbeddingMatcher({ client: clientHigh });
    const highResult = await matcherHigh.match(
      mkEntity({ id: ID_ENTITY, name: 'EntityA' }),
      [mkEntity({ id: ID_C1, name: 'Above' })],
    );
    expect(highResult.matched).toBe(true);
    expect(highResult.confidence).toBeCloseTo(0.91, 6);
  });

  test('never matches entity.id === candidate.id (self)', async () => {
    // Self-candidate has identical embedding (cosine 1.0), but id matches
    // so it MUST be skipped. The only "valid" candidate has cosine 0.
    const embeddings = new Map<string, number[]>([
      ['EntityA', [1, 0, 0]],
      ['Other', [0, 1, 0]],
    ]);
    const client = makeFakeEmbeddingClient({ embeddings });
    const matcher = new CosineEmbeddingMatcher({ client });
    const entity = mkEntity({ id: ID_ENTITY, name: 'EntityA' });
    const self = mkEntity({ id: ID_ENTITY, name: 'EntityA' });
    const other = mkEntity({ id: ID_C1, name: 'Other' });
    const result = await matcher.match(entity, [self, other]);
    expect(result.matched).toBe(false);
    expect(result.survivor).toBeUndefined();
  });

  test('picks best candidate when multiple exceed threshold', async () => {
    // Entity at [1, 0]; three candidates at cosines 0.91, 0.95, 0.93.
    const embeddings = new Map<string, number[]>([
      ['EntityA', [1, 0]],
      ['C1', unitAtCosine(0.91)],
      ['C2', unitAtCosine(0.95)],
      ['C3', unitAtCosine(0.93)],
    ]);
    const client = makeFakeEmbeddingClient({ embeddings });
    const matcher = new CosineEmbeddingMatcher({ client });
    const entity = mkEntity({ id: ID_ENTITY, name: 'EntityA' });
    const candidates = [
      mkEntity({ id: ID_C1, name: 'C1' }),
      mkEntity({ id: ID_C2, name: 'C2' }),
      mkEntity({ id: ID_C3, name: 'C3' }),
    ];
    const result = await matcher.match(entity, candidates);
    expect(result.matched).toBe(true);
    expect(result.survivor?.id).toBe(ID_C2);
    expect(result.confidence).toBeCloseTo(0.95, 6);
  });

  test('textOf opt overrides default name+description concatenation', async () => {
    // textOf maps entity → uppercase name. Tests that the override is honored
    // by asserting the embed-call argument is the uppercase string.
    const embeddings = new Map<string, number[]>([
      ['USERAUTH', [1, 0, 0]],
      ['SESSIONMANAGER', [0, 1, 0]],
    ]);
    const client = makeFakeEmbeddingClient({ embeddings });
    const matcher = new CosineEmbeddingMatcher({
      client,
      textOf: (e) => e.name.toUpperCase(),
    });
    const entity = mkEntity({ id: ID_ENTITY, name: 'UserAuth' });
    const candidate = mkEntity({ id: ID_C1, name: 'SessionManager' });
    await matcher.match(entity, [candidate]);
    expect(client.embed).toHaveBeenCalledWith('USERAUTH');
    expect(client.embed).toHaveBeenCalledWith('SESSIONMANAGER');
  });
});

// Phase 40 Plan 02 (DEDUP-01): JaccardNameMatcher unit tests.
//
// Pure-function test pattern (mirrors tests/unit/segments-merge.test.ts).
// No store, no I/O — exercises the 7 contract cases enumerated in
// 40-PATTERNS.md offset 704-715.
//
// Contract cases:
//   1. exact match returns confidence 1.0
//   2. no shared words returns confidence 0
//   3. mixed case is normalized (case-insensitive)
//   4. threshold default 0.85 — below-threshold score returns matched: false
//   5. threshold opt overrides default
//   6. never matches against entity.id === candidate.id (self-match)
//   7. picks best candidate when multiple exceed threshold

import { describe, test, expect } from 'vitest';
import { JaccardNameMatcher } from '../../src/dedup/JaccardNameMatcher.js';
import { mkEntity } from './_helpers/fakes.js';
import type { EntityId } from '../../src/index.js';

describe('JaccardNameMatcher', () => {
  test('exact match returns confidence 1.0', async () => {
    const matcher = new JaccardNameMatcher();
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000001' as EntityId,
      name: 'PaymentService',
    });
    const candidate = mkEntity({
      id: '0192a000-0000-7000-8000-000000000002' as EntityId,
      name: 'PaymentService',
    });
    const result = await matcher.match(entity, [candidate]);
    expect(result.matched).toBe(true);
    expect(result.survivor?.id).toBe(candidate.id);
    expect(result.confidence).toBe(1);
  });

  test('no shared words returns confidence 0', async () => {
    const matcher = new JaccardNameMatcher();
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000001' as EntityId,
      name: 'Alpha Beta',
    });
    const candidate = mkEntity({
      id: '0192a000-0000-7000-8000-000000000002' as EntityId,
      name: 'Gamma Delta',
    });
    const result = await matcher.match(entity, [candidate]);
    expect(result.matched).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.survivor).toBeUndefined();
  });

  test('mixed case is normalized (case-insensitive)', async () => {
    const matcher = new JaccardNameMatcher();
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000001' as EntityId,
      name: 'User Auth Service',
    });
    const candidate = mkEntity({
      id: '0192a000-0000-7000-8000-000000000002' as EntityId,
      name: 'USER AUTH SERVICE',
    });
    const result = await matcher.match(entity, [candidate]);
    expect(result.matched).toBe(true);
    expect(result.survivor?.id).toBe(candidate.id);
    expect(result.confidence).toBe(1);
  });

  test('threshold default 0.85 — confidence 0.84 returns matched: false', async () => {
    const matcher = new JaccardNameMatcher();
    // 5 shared words + 1 unique word each side → intersection=5, union=6 → 5/6 ≈ 0.833 (< 0.85)
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000001' as EntityId,
      name: 'one two three four five six',
    });
    const candidate = mkEntity({
      id: '0192a000-0000-7000-8000-000000000002' as EntityId,
      name: 'one two three four five seven',
    });
    const result = await matcher.match(entity, [candidate]);
    expect(result.matched).toBe(false);
    expect(result.confidence).toBe(0);
    // Sanity: the raw Jaccard for the candidate pair would be < 0.85
    // (5/6 ≈ 0.833). Confirmed by the matched: false result above —
    // the matcher only returns a non-zero confidence when a candidate
    // exceeds threshold.
  });

  test('threshold opt overrides default', async () => {
    const matcher = new JaccardNameMatcher({ threshold: 0.5 });
    // Same name pair as the 0.85 boundary test — Jaccard ≈ 0.833,
    // which now exceeds the lowered 0.5 threshold.
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000001' as EntityId,
      name: 'one two three four five six',
    });
    const candidate = mkEntity({
      id: '0192a000-0000-7000-8000-000000000002' as EntityId,
      name: 'one two three four five seven',
    });
    const result = await matcher.match(entity, [candidate]);
    expect(result.matched).toBe(true);
    expect(result.survivor?.id).toBe(candidate.id);
    expect(result.confidence).toBeCloseTo(5 / 6, 5);
    expect(matcher.threshold).toBe(0.5);
  });

  test('never matches against entity.id === candidate.id (self-match)', async () => {
    const matcher = new JaccardNameMatcher();
    const sharedId = '0192a000-0000-7000-8000-000000000001' as EntityId;
    const entity = mkEntity({ id: sharedId, name: 'PaymentService' });
    // Same id, identical name — would score 1.0 if self-match were allowed.
    const candidate = mkEntity({ id: sharedId, name: 'PaymentService' });
    const result = await matcher.match(entity, [candidate]);
    expect(result.matched).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.survivor).toBeUndefined();
  });

  test('picks best candidate when multiple exceed threshold', async () => {
    const matcher = new JaccardNameMatcher();
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000001' as EntityId,
      name: 'a b c d e f g h i j k l m n',
    });
    // candidate1: 13 shared / 15 union → 0.867 (just above threshold)
    const candidate1 = mkEntity({
      id: '0192a000-0000-7000-8000-000000000002' as EntityId,
      name: 'a b c d e f g h i j k l m o',
    });
    // candidate2: 14 shared / 15 union → 0.933 (clearly higher)
    const candidate2 = mkEntity({
      id: '0192a000-0000-7000-8000-000000000003' as EntityId,
      name: 'a b c d e f g h i j k l m n p',
    });
    const result = await matcher.match(entity, [candidate1, candidate2]);
    expect(result.matched).toBe(true);
    expect(result.survivor?.id).toBe(candidate2.id);
    expect(result.confidence).toBeCloseTo(14 / 15, 5);
  });
});

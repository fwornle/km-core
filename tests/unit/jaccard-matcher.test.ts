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
    // 11 shared words + 1 unique word each side → intersection=11, union=13 → 11/13 ≈ 0.846 (< 0.85).
    // Just barely below the default threshold — exercises the boundary.
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000001' as EntityId,
      name: 'a b c d e f g h i j k l',
    });
    const candidate = mkEntity({
      id: '0192a000-0000-7000-8000-000000000002' as EntityId,
      name: 'a b c d e f g h i j k m',
    });
    const result = await matcher.match(entity, [candidate]);
    expect(result.matched).toBe(false);
    expect(result.confidence).toBe(0);
    // The matcher returns confidence: 0 on the no-match path even though
    // the raw Jaccard score (~0.846) is non-zero — by D-44 the
    // below-threshold confidence is informational only and 0 signals "no
    // layer match" to LayeredDeduplicator.
  });

  test('threshold opt overrides default', async () => {
    const matcher = new JaccardNameMatcher({ threshold: 0.5 });
    // Same name pair as the 0.85 boundary test — Jaccard 11/13 ≈ 0.846,
    // which now exceeds the lowered 0.5 threshold.
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000001' as EntityId,
      name: 'a b c d e f g h i j k l',
    });
    const candidate = mkEntity({
      id: '0192a000-0000-7000-8000-000000000002' as EntityId,
      name: 'a b c d e f g h i j k m',
    });
    const result = await matcher.match(entity, [candidate]);
    expect(result.matched).toBe(true);
    expect(result.survivor?.id).toBe(candidate.id);
    expect(result.confidence).toBeCloseTo(11 / 13, 5);
    expect(matcher.threshold).toBe(0.5);
  });

  test('CR-02: legacy-id re-extraction — same-id candidate matches itself', async () => {
    // CR-02 (40-REVIEW.md offset 83-109, VERIFICATION.md gap #2): the
    // previous `if (candidate.id === entity.id) continue;` guard was dead
    // code on the happy path (pipeline calls dedup BEFORE putEntity, so
    // freshly-minted ids never collide) AND actively WRONG on the legacy-id
    // re-extraction path — when an extractor re-emits a previously-stored
    // entity at its same id, the guard skipped the perfect match and the
    // pipeline silently wrote a duplicate. With the guard removed (Plan
    // 40-09), an exact id collision IS the same logical entity, which IS
    // what dedup is meant to catch. (Replaces the obsolete
    // `'never matches against entity.id === candidate.id'` test that pinned
    // the now-removed self-id guard.)
    const matcher = new JaccardNameMatcher();
    const sharedId = '0192a000-0000-7000-8000-000000000001' as EntityId;
    const newEntity = mkEntity({ id: sharedId, name: 'UserAuthService' });
    // Same id, identical name — legacy-id re-extraction case. Must score 1.0.
    const candidate = mkEntity({ id: sharedId, name: 'UserAuthService' });
    const result = await matcher.match(newEntity, [candidate]);
    expect(result.matched).toBe(true);
    expect(result.survivor?.id).toBe(sharedId);
    expect(result.confidence).toBeCloseTo(1.0, 10);
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

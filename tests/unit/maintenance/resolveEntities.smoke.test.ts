// Phase 41 Plan 06 Task 1 RED gate — failing smoke test for resolveEntities.
//
// This file is deleted post-GREEN; it exists only to anchor the RED commit
// in git history (mirrors the Plan 05 RED-gate pattern at km-core
// 74fb5fc test(41-05) smoke test for mergeEntities). Task 2's comprehensive
// behavioural suite is in resolveEntities.test.ts.

import { describe, test, expect } from 'vitest';

describe('resolveEntities (Phase 41 Plan 06) — RED gate', () => {
  test('module exposes resolveEntities', async () => {
    const mod = await import(
      '../../../src/maintenance/resolveEntities.js'
    );
    expect(typeof mod.resolveEntities).toBe('function');
  });
});

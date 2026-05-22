// Phase 41 Plan 05 Task 1 RED smoke test: pins the public surface of
// `mergeEntities` (file exists, function exported, signature shape).
//
// This file is the minimal RED gate; the full behavioral suite lives in
// `mergeEntities.test.ts` (Task 2). The smoke test is intentionally tiny
// so the RED→GREEN cycle for Task 1 doesn't bleed into Task 2's coverage.

import { describe, test, expect } from 'vitest';
import { mergeEntities } from '../../../src/maintenance/mergeEntities.js';

describe('mergeEntities — smoke', () => {
  test('exports a callable function', () => {
    expect(typeof mergeEntities).toBe('function');
  });
});

// CORE-03: UUIDv7 stamping, parsing, validation, k-sortability
//
// Wave 0 RED state: `mintEntityId` and `parseEntityId` are not yet exported
// from '../../src/index.js'. Plan 02 (CORE-03 implementation) wires them.

import { describe, test, expect } from 'vitest';
import { mintEntityId, parseEntityId } from '../../src/index.js';

// RFC 9562 UUIDv7 regex: 8-4-7+3-variant+3-12 hex, version nibble pinned to 7
// (position 14 in the string-form is the version char).
const uuidv7Regex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('mintEntityId', () => {
  test('returns a string matching the UUIDv7 regex', () => {
    const id = mintEntityId();
    expect(id).toMatch(uuidv7Regex);
  });
});

describe('parseEntityId', () => {
  test('parseEntityId(mintEntityId()) returns the same string', () => {
    const id = mintEntityId();
    expect(parseEntityId(id)).toBe(id);
  });

  test("parseEntityId('not-a-uuid') throws SyntaxError", () => {
    expect(() => parseEntityId('not-a-uuid')).toThrow(SyntaxError);
  });

  test('parseEntityId rejects a UUIDv4 (version nibble must be 7)', () => {
    // Per 37-PATTERNS.md §src/ids/parse.ts DELTAS: assert s.charAt(14) === '7'.
    // The fixed UUIDv4 below has '4' at position 14 → must throw.
    expect(() =>
      parseEntityId('00000000-0000-4000-8000-000000000000'),
    ).toThrow();
  });
});

describe('UUIDv7 k-sortability', () => {
  test('IDs minted in creation order sort lexicographically in creation order', async () => {
    // D-08: UUIDv7 timestamps live in the most-significant bits, so the
    // string-form sorts lexicographically by creation time. Mint 100 IDs in
    // 10 batches of 10 with a setImmediate gap so the millisecond clock can
    // tick at least once across batches.
    const ids: string[] = [];
    for (let batch = 0; batch < 10; batch++) {
      for (let i = 0; i < 10; i++) {
        ids.push(mintEntityId());
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    const lexicographic = [...ids].sort();
    expect(lexicographic).toEqual(ids);
  });
});

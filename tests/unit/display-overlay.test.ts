// Phase 45 Plan 04 Task 1 — display-overlay loader unit tests.
//
// 4 behavior tests per 45-04-PLAN.md Task 1 <behavior>:
//   Test 1: missing file → returns {} (no exception)
//   Test 2: valid display.json → parsed Record with all entries
//   Test 3: malformed JSON → stderr warning + returns {} (no throw)
//   Test 4: empty ontologyDir throws (CLAUDE.md ontologyDir-invariant)
//
// no-console-log: stderr inspection via vi.spyOn(process.stderr, 'write').

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadDisplayOverlay, parseDisplayHint } from '../../src/ontology/display-overlay.js';
import type { DisplayHint } from '../../src/ontology/display-overlay.js';

describe('loadDisplayOverlay (Plan 45-04 Task 1)', () => {
  let tmpdir: string;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-display-overlay-'));
  });

  afterEach(() => {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  test('Overlay Test 1: missing file returns {} (no exception)', () => {
    // No `${tmpdir}/coding.display.json` written — file does not exist.
    expect(() => loadDisplayOverlay(tmpdir, 'coding')).not.toThrow();
    const result = loadDisplayOverlay(tmpdir, 'coding');
    expect(result).toEqual({});
  });

  test('Overlay Test 2: valid display.json returns parsed Record with all entries', () => {
    const overlay: Record<string, DisplayHint> = {
      Observation: { color: '#3b82f6', icon: 'Activity', shape: 'circle' },
      Digest: { color: '#10b981', icon: 'FileText', shape: 'circle' },
      Insight: { color: '#f59e0b', icon: 'Lightbulb', shape: 'circle' },
      Component: { color: '#8b5cf6', icon: 'Package', shape: 'square' },
      Detail: { color: '#6b7280', icon: 'Layers', shape: 'circle' },
    };
    fs.writeFileSync(
      path.join(tmpdir, 'coding.display.json'),
      JSON.stringify(overlay, null, 2),
      'utf8',
    );

    const result = loadDisplayOverlay(tmpdir, 'coding');
    expect(result).toEqual(overlay);
    expect(result['Observation']?.color).toBe('#3b82f6');
    expect(result['Component']?.shape).toBe('square');
    expect(Object.keys(result).length).toBe(5);
  });

  test('Overlay Test 3: malformed JSON logs stderr warning + returns {} (no throw)', () => {
    fs.writeFileSync(
      path.join(tmpdir, 'coding.display.json'),
      '{ "Observation": { "color": ',  // truncated — invalid JSON
      'utf8',
    );
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    let result: Record<string, DisplayHint> = { sentinel: { color: 'unset' } };
    expect(() => {
      result = loadDisplayOverlay(tmpdir, 'coding');
    }).not.toThrow();
    expect(result).toEqual({});

    // Exactly one warning line written; mentions the path + 'malformed JSON'.
    expect(stderrSpy).toHaveBeenCalled();
    const messages = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(messages).toContain('malformed JSON');
    expect(messages).toContain('coding.display.json');

    stderrSpy.mockRestore();
  });

  test('Overlay Test 3b: top-level array instead of object → stderr + returns {}', () => {
    fs.writeFileSync(
      path.join(tmpdir, 'coding.display.json'),
      JSON.stringify([{ color: '#fff' }]),
      'utf8',
    );
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const result = loadDisplayOverlay(tmpdir, 'coding');
    expect(result).toEqual({});
    const messages = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(messages).toContain('not an object');

    stderrSpy.mockRestore();
  });

  test('Overlay Test 4: empty ontologyDir throws (CLAUDE.md invariant)', () => {
    expect(() => loadDisplayOverlay('', 'coding')).toThrow(
      /ontologyDir is required/,
    );
  });

  test('Overlay Test 4b: empty system throws (defensive)', () => {
    expect(() => loadDisplayOverlay(tmpdir, '')).toThrow(/system is required/);
  });
});

// Phase 55 Plan 02 Task 1 — Zod schema extension for borderStyle + pulseRule.
//
// 7 behavior tests per 55-02-PLAN.md Task 1 <behavior>:
//   Plan-55-02 Test 1: parseDisplayHint({borderStyle:'solid'}) → ok
//   Plan-55-02 Test 2: parseDisplayHint({borderStyle:'dashed'}) → ok
//   Plan-55-02 Test 3: parseDisplayHint({borderStyle:'fuzzy'}) → throws (Zod)
//   Plan-55-02 Test 4: parseDisplayHint({pulseRule:null}) → ok
//   Plan-55-02 Test 5: parseDisplayHint({pulseRule:'lastUpdatedWithin:60s'}) → ok
//   Plan-55-02 Test 6: parseDisplayHint({pulseRule:'lastUpdatedWithin:90s'}) → throws
//   Plan-55-02 Test 7: BC — parseDisplayHint({color, shape}) returns input verbatim
//
// Phase 45 BC invariant (loadDisplayOverlay) preserved by re-asserting the
// Phase-41 empty-ontologyDir throw (Test 4 above) and that overlays with the
// new fields round-trip through the loader (Test 8 — round-trip integration).
describe('parseDisplayHint Zod schema (Plan 55-02 Task 1)', () => {
  test('Plan-55-02 Test 1: borderStyle "solid" parses without throwing', () => {
    expect(() => parseDisplayHint({ borderStyle: 'solid' })).not.toThrow();
    const r = parseDisplayHint({ borderStyle: 'solid' });
    expect(r.borderStyle).toBe('solid');
  });

  test('Plan-55-02 Test 2: borderStyle "dashed" parses without throwing', () => {
    expect(() => parseDisplayHint({ borderStyle: 'dashed' })).not.toThrow();
    const r = parseDisplayHint({ borderStyle: 'dashed' });
    expect(r.borderStyle).toBe('dashed');
  });

  test('Plan-55-02 Test 3: borderStyle "fuzzy" rejected (Zod enum)', () => {
    expect(() => parseDisplayHint({ borderStyle: 'fuzzy' })).toThrow();
    try {
      parseDisplayHint({ borderStyle: 'fuzzy' });
    } catch (err: unknown) {
      // Zod error must mention the offending field
      expect(String(err)).toContain('borderStyle');
    }
  });

  test('Plan-55-02 Test 4: pulseRule null parses without throwing', () => {
    expect(() => parseDisplayHint({ pulseRule: null })).not.toThrow();
    const r = parseDisplayHint({ pulseRule: null });
    expect(r.pulseRule).toBeNull();
  });

  test('Plan-55-02 Test 5: pulseRule "lastUpdatedWithin:60s" parses without throwing', () => {
    expect(() => parseDisplayHint({ pulseRule: 'lastUpdatedWithin:60s' })).not.toThrow();
    const r = parseDisplayHint({ pulseRule: 'lastUpdatedWithin:60s' });
    expect(r.pulseRule).toBe('lastUpdatedWithin:60s');
  });

  test('Plan-55-02 Test 5b: pulseRule "lastUpdatedWithin:5m" parses', () => {
    expect(() => parseDisplayHint({ pulseRule: 'lastUpdatedWithin:5m' })).not.toThrow();
    const r = parseDisplayHint({ pulseRule: 'lastUpdatedWithin:5m' });
    expect(r.pulseRule).toBe('lastUpdatedWithin:5m');
  });

  test('Plan-55-02 Test 5c: pulseRule "recentlyMerged:1h" parses', () => {
    expect(() => parseDisplayHint({ pulseRule: 'recentlyMerged:1h' })).not.toThrow();
    const r = parseDisplayHint({ pulseRule: 'recentlyMerged:1h' });
    expect(r.pulseRule).toBe('recentlyMerged:1h');
  });

  test('Plan-55-02 Test 6: pulseRule "lastUpdatedWithin:90s" (unknown) rejected', () => {
    expect(() => parseDisplayHint({ pulseRule: 'lastUpdatedWithin:90s' })).toThrow();
  });

  test('Plan-55-02 Test 7: BC — color+shape input round-trips without forcing new fields', () => {
    const input = { color: '#abc', shape: 'circle' as const };
    const r = parseDisplayHint(input);
    expect(r).toEqual({ color: '#abc', shape: 'circle' });
    // Critically: undefined new fields stay undefined (no defaults injected).
    expect(r.borderStyle).toBeUndefined();
    expect(r.pulseRule).toBeUndefined();
  });

  test('Plan-55-02 Test 7b: empty object parses to empty (full BC)', () => {
    const r = parseDisplayHint({});
    expect(r).toEqual({});
    expect(r.borderStyle).toBeUndefined();
    expect(r.pulseRule).toBeUndefined();
  });

  test('Plan-55-02 Test 7c: all-fields-together input round-trips', () => {
    const input: DisplayHint = {
      color: '#10b981',
      icon: '📝',
      shape: 'circle' as const,
      borderStyle: 'solid' as const,
      pulseRule: 'lastUpdatedWithin:60s' as const,
    };
    const r = parseDisplayHint(input);
    expect(r).toEqual(input);
  });
});

// Integration: loadDisplayOverlay must surface the new fields when present in
// the overlay JSON file. Phase-41 invariant (empty ontologyDir → throw) is
// already covered by Test 4 above; we re-anchor it here for explicit Plan 55-02
// behavior coverage.
describe('loadDisplayOverlay with Phase 55 fields (Plan 55-02 Task 1)', () => {
  let tmpdir: string;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-display-overlay-55-'));
  });

  afterEach(() => {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  test('Plan-55-02 Test 8: overlay with borderStyle + pulseRule round-trips via loader', () => {
    const overlay: Record<string, DisplayHint> = {
      Observation: {
        color: '#10b981',
        icon: '📝',
        shape: 'circle',
        borderStyle: 'solid',
        pulseRule: 'lastUpdatedWithin:60s',
      },
      Project: {
        color: '#0ea5e9',
        icon: '🏗',
        shape: 'hexagon' as const,
        borderStyle: 'solid',
        pulseRule: null,
      },
    };
    fs.writeFileSync(
      path.join(tmpdir, 'coding.display.json'),
      JSON.stringify(overlay, null, 2),
      'utf8',
    );
    const result = loadDisplayOverlay(tmpdir, 'coding');
    expect(result['Observation']?.borderStyle).toBe('solid');
    expect(result['Observation']?.pulseRule).toBe('lastUpdatedWithin:60s');
    expect(result['Project']?.pulseRule).toBeNull();
    expect(result['Project']?.shape).toBe('hexagon');
  });

  test('Plan-55-02 Test 9: Phase-41 invariant preserved — empty ontologyDir throws', () => {
    expect(() => loadDisplayOverlay('', 'coding')).toThrow(/ontologyDir is required/);
  });
});

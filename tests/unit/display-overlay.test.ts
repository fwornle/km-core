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
import { loadDisplayOverlay } from '../../src/ontology/display-overlay.js';
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

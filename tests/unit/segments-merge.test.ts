// Phase 39 Plan 02 (DATA-02): per-segment provenance writer unit tests.
//
// Covers the 8 boundary cases enumerated in 39-PATTERNS §"tests/unit/
// segments-merge.test.ts" (cases a/b/c/e/g + D-41 segment-cap + D-41
// confirmation-cap + D-39 purity), mirroring the boundary set from
// 39-RESEARCH §"Pattern 4: Segment-Merge Helper".
//
// no-console-log: D-41 monitoring tests spy on `process.stderr.write`
// (NOT `console.warn`) — matches the production emission path in
// src/segments/merge.ts and the broader Phase 37/38 stderr-warn convention.

import { describe, test, expect, vi, afterEach } from 'vitest';
import { mergeDescriptionSegment } from '../../src/segments/merge.js';
import type { Entity, DescriptionSegment } from '../../src/index.js';
import type { EntityId } from '../../src/index.js';

/** Build a baseline Entity with `metadata: {}` (the Phase 37/38 default —
 *  no `descriptionSegments` key). Tests opt into pre-populating segments
 *  by overriding `metadata`. */
function mkEntity(overrides?: Partial<Entity>): Entity {
  return {
    id: '0192a000-0000-7000-8000-000000000000' as EntityId,
    name: 'TestEntity',
    entityType: 'Component',
    layer: 'evidence',
    description: '',
    createdAt: '2026-05-20T00:00:00.000Z',
    updatedAt: '2026-05-20T00:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}

/** Build a baseline DescriptionSegment. Tests override `text`, `runId`,
 *  `timestamp` etc. as needed. `confirmations` defaults to `[]` (caller
 *  convention for newly-created segments). */
function mkSegment(
  text: string,
  overrides?: Partial<DescriptionSegment>,
): DescriptionSegment {
  return {
    text,
    runId: 'r1',
    provider: 'p',
    model: 'm',
    quality: 'standard',
    timestamp: '2026-05-20T00:00:00.000Z',
    confirmations: [],
    ...overrides,
  };
}

describe('mergeDescriptionSegment (D-39, D-40, D-41)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('appends confirmation on identical text post-normalize (D-40 case a)', () => {
    const entity = mkEntity({
      metadata: {
        descriptionSegments: [mkSegment('hello world')],
      },
    });
    const result = mergeDescriptionSegment(
      entity,
      mkSegment('hello world', { runId: 'r2', timestamp: 'T2' }),
    );

    const segments = result.metadata.descriptionSegments as DescriptionSegment[];
    expect(segments.length).toBe(1);
    expect(segments[0].confirmations.length).toBe(1);
    expect(segments[0].confirmations[0]).toEqual({
      runId: 'r2',
      provider: 'p',
      model: 'm',
      timestamp: 'T2',
    });
  });

  test('treats "hello world" and "hello  world" (double space) as identical (D-40 case b)', () => {
    const entity = mkEntity({
      metadata: {
        descriptionSegments: [mkSegment('hello world')],
      },
    });
    const result = mergeDescriptionSegment(
      entity,
      mkSegment('hello  world', { runId: 'r2' }), // double space
    );

    const segments = result.metadata.descriptionSegments as DescriptionSegment[];
    expect(segments.length).toBe(1);
    expect(segments[0].confirmations.length).toBe(1);
    expect(segments[0].confirmations[0].runId).toBe('r2');
  });

  test('distinguishes "Code" from "code" (case-sensitive — D-40 case c)', () => {
    const entity = mkEntity({
      metadata: {
        descriptionSegments: [mkSegment('Code')],
      },
    });
    const result = mergeDescriptionSegment(
      entity,
      mkSegment('code', { runId: 'r2' }),
    );

    const segments = result.metadata.descriptionSegments as DescriptionSegment[];
    // Case-sensitive: no match, new segment pushed.
    expect(segments.length).toBe(2);
    expect(segments[0].text).toBe('Code');
    expect(segments[0].confirmations.length).toBe(0);
    expect(segments[1].text).toBe('code');
  });

  test('matches NBSP and ideographic space against ASCII space (D-40 case e)', () => {
    const entity = mkEntity({
      metadata: {
        descriptionSegments: [mkSegment('hello world')],
      },
    });
    // NBSP (U+00A0): 'hello world' — `\s` matches it.
    const result1 = mergeDescriptionSegment(
      entity,
      mkSegment('hello world', { runId: 'r2' }),
    );
    // Ideographic space (U+3000): 'hello　world' — `\s` matches it.
    const result2 = mergeDescriptionSegment(
      result1,
      mkSegment('hello　world', { runId: 'r3' }),
    );

    const segments = result2.metadata
      .descriptionSegments as DescriptionSegment[];
    expect(segments.length).toBe(1);
    expect(segments[0].confirmations.length).toBe(2);
    expect(segments[0].confirmations[0].runId).toBe('r2');
    expect(segments[0].confirmations[1].runId).toBe('r3');
  });

  test('initializes descriptionSegments[] when entity.metadata has no such key (case g)', () => {
    const entity = mkEntity({ metadata: {} }); // Phase 37/38 default
    const result = mergeDescriptionSegment(entity, mkSegment('first text'));

    const segments = result.metadata.descriptionSegments as DescriptionSegment[];
    expect(Array.isArray(segments)).toBe(true);
    expect(segments.length).toBe(1);
    expect(segments[0].text).toBe('first text');
    expect(segments[0].confirmations).toEqual([]);
  });

  test('emits stderr-warn at >100 segments (D-41 threshold)', () => {
    // Pre-populate with 100 distinct-text segments (case f).
    const seedSegments: DescriptionSegment[] = [];
    for (let i = 0; i < 100; i++) {
      seedSegments.push(mkSegment(`seg-${String(i)}`));
    }
    const entity = mkEntity({
      metadata: { descriptionSegments: seedSegments },
    });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = mergeDescriptionSegment(
      entity,
      mkSegment('seg-100'), // distinct → pushes 101st
    );

    const segments = result.metadata.descriptionSegments as DescriptionSegment[];
    expect(segments.length).toBe(101);

    // At least one stderr write matches the >100 monitoring template.
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => /has 101 descriptionSegments \(>100/.test(s))).toBe(
      true,
    );
  });

  test('emits stderr-warn at >50 confirmations on a segment (D-41 threshold)', () => {
    // Pre-populate one segment with 50 confirmations.
    const confirmations = [];
    for (let i = 0; i < 50; i++) {
      confirmations.push({
        runId: `r${String(i)}`,
        provider: 'p',
        model: 'm',
        timestamp: 'T',
      });
    }
    const entity = mkEntity({
      metadata: {
        descriptionSegments: [mkSegment('same text', { confirmations })],
      },
    });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const result = mergeDescriptionSegment(
      entity,
      mkSegment('same text', { runId: 'r51' }),
    );

    const segments = result.metadata.descriptionSegments as DescriptionSegment[];
    expect(segments.length).toBe(1);
    expect(segments[0].confirmations.length).toBe(51);

    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => /has 51 confirmations \(>50/.test(s))).toBe(true);
  });

  test('drops caller-supplied confirmations[] on D-40 miss (WR-04 provenance injection mitigation)', () => {
    // WR-04 regression guard: on a D-40 miss (no normalized-text match),
    // the helper MUST start the pushed segment with an empty
    // confirmations[] regardless of what the caller passed. Previously
    // it preserved caller-supplied confirmations[] verbatim, which let
    // a caller (e.g. one constructing newSegment from external JSON)
    // inject fabricated provenance entries without going through the
    // normal confirmation-append path.
    const entity = mkEntity({
      metadata: {
        descriptionSegments: [mkSegment('existing text')],
      },
    });
    // Caller pre-populates confirmations[] with a structurally-invalid /
    // suspicious entry. The fix must DROP this on the miss branch.
    const injectedConfirmations = [
      {
        runId: 'attacker-controlled-run-id',
        provider: 'fake-provider',
        model: 'fake-model',
        timestamp: '1970-01-01T00:00:00.000Z',
      },
    ];
    const result = mergeDescriptionSegment(
      entity,
      mkSegment('completely different text', {
        runId: 'r-legit',
        confirmations: injectedConfirmations,
      }),
    );

    const segments = result.metadata.descriptionSegments as DescriptionSegment[];
    expect(segments.length).toBe(2);
    // The new (no-match) segment must have a FRESH empty confirmations[] —
    // the caller-supplied injectedConfirmations is dropped.
    expect(segments[1].text).toBe('completely different text');
    expect(segments[1].confirmations).toEqual([]);
    // The pre-existing segment is unaffected.
    expect(segments[0].text).toBe('existing text');
    expect(segments[0].confirmations).toEqual([]);
  });

  test('is a pure function — input entity reference is NOT mutated (D-39)', () => {
    const entity = mkEntity({
      metadata: {
        descriptionSegments: [mkSegment('original text')],
      },
    });
    const before = JSON.parse(JSON.stringify(entity));

    const result = mergeDescriptionSegment(
      entity,
      mkSegment('original text', { runId: 'r2' }),
    );

    // Input entity is value-equal to its pre-call snapshot (no mutation).
    expect(JSON.stringify(entity)).toBe(JSON.stringify(before));
    // Returned entity is a new object reference.
    expect(Object.is(result, entity)).toBe(false);
    // metadata is a new object reference.
    expect(Object.is(result.metadata, entity.metadata)).toBe(false);
    // descriptionSegments[] is a new array reference.
    const origSegments = entity.metadata
      .descriptionSegments as DescriptionSegment[];
    const newSegments = result.metadata
      .descriptionSegments as DescriptionSegment[];
    expect(Object.is(newSegments, origSegments)).toBe(false);

    // And the returned entity DOES carry the new confirmation.
    expect(newSegments[0].confirmations.length).toBe(1);
    expect(newSegments[0].confirmations[0].runId).toBe('r2');
  });
});

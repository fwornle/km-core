// Phase 40 Plan 05 (DEDUP-01): LayeredDeduplicator orchestrator unit tests.
//
// Covers the 9 test cases enumerated in 40-PLAN.md Task 1 <behavior>, mirroring
// the Validation Architecture line 928-933 in 40-RESEARCH.md:
//   - exact-name layer catches first when matching
//   - embedding layer catches when exact-name does not match
//   - llm-semantic layer catches when others do not match
//   - short-circuits on first matched layer when shortCircuit: true (default)
//   - shortCircuit: false runs all layers even after match (first-matched-wins)
//   - omitted layer slots are skipped
//   - runs layers in declared order: exactName → embedding → llmSemantic
//   - returns matched: false when no layer matches above threshold
//   - Pitfall 1: entity without ontologyClass AND without entityType — returns
//     matched: false + stderr-warn
//
// no-console-log: Pitfall 1 monitoring test spies on `process.stderr.write`
// (NOT `console.warn`) — matches the production emission path in
// src/dedup/LayeredDeduplicator.ts and the broader Phase 37/38/39/40
// stderr-warn convention.

import { describe, test, expect, vi, afterEach } from 'vitest';
import { LayeredDeduplicator } from '../../src/dedup/LayeredDeduplicator.js';
import type {
  ExactNameLayer,
  EmbeddingLayer,
  LLMSemanticLayer,
} from '../../src/dedup/types.js';
import type { Entity } from '../../src/index.js';
import type { EntityId } from '../../src/index.js';
import { mkEntity, makeLayerStub } from './_helpers/fakes.js';

describe('LayeredDeduplicator (D-44 short-circuit orchestrator)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('exact-name layer catches first when matching', async () => {
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000010' as EntityId,
      name: 'NewEntity',
    });
    const survivor = mkEntity({
      id: '0192a000-0000-7000-8000-000000000001' as EntityId,
      name: 'NewEntity',
    });
    const exactName = makeLayerStub({
      kind: 'exactName',
      willMatch: true,
      survivor,
      confidence: 0.95,
    });
    const embedding = makeLayerStub({ kind: 'embedding', willMatch: false });
    const llmSemantic = makeLayerStub({
      kind: 'llmSemantic',
      willMatch: false,
    });

    const dedup = new LayeredDeduplicator({
      exactName,
      embedding,
      llmSemantic,
    });

    const result = await dedup.dedup(entity, [survivor]);

    expect(result.matched).toBe(true);
    expect(result.matchedLayer).toBe('exactName');
    expect(result.confidence).toBe(0.95);
    expect(result.survivor).toBe(survivor);
    expect(exactName.match).toHaveBeenCalledTimes(1);
    expect(embedding.match).toHaveBeenCalledTimes(0);
    expect(llmSemantic.match).toHaveBeenCalledTimes(0);
  });

  test('embedding layer catches when exact-name does not match', async () => {
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000020' as EntityId,
      name: 'EntityName',
    });
    const survivor = mkEntity({
      id: '0192a000-0000-7000-8000-000000000002' as EntityId,
      name: 'DifferentName',
    });
    const exactName = makeLayerStub({ kind: 'exactName', willMatch: false });
    const embedding = makeLayerStub({
      kind: 'embedding',
      willMatch: true,
      survivor,
      confidence: 0.92,
    });
    const llmSemantic = makeLayerStub({
      kind: 'llmSemantic',
      willMatch: false,
    });

    const dedup = new LayeredDeduplicator({
      exactName,
      embedding,
      llmSemantic,
    });

    const result = await dedup.dedup(entity, [survivor]);

    expect(result.matched).toBe(true);
    expect(result.matchedLayer).toBe('embedding');
    expect(result.confidence).toBe(0.92);
    expect(result.survivor).toBe(survivor);
    expect(exactName.match).toHaveBeenCalledTimes(1);
    expect(embedding.match).toHaveBeenCalledTimes(1);
    expect(llmSemantic.match).toHaveBeenCalledTimes(0);
  });

  test('llm-semantic layer catches when others do not match', async () => {
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000030' as EntityId,
      name: 'EntityName',
    });
    const survivor = mkEntity({
      id: '0192a000-0000-7000-8000-000000000003' as EntityId,
      name: 'CompletelyDifferent',
    });
    const exactName = makeLayerStub({ kind: 'exactName', willMatch: false });
    const embedding = makeLayerStub({ kind: 'embedding', willMatch: false });
    const llmSemantic = makeLayerStub({
      kind: 'llmSemantic',
      willMatch: true,
      survivor,
      confidence: 0.81,
    });

    const dedup = new LayeredDeduplicator({
      exactName,
      embedding,
      llmSemantic,
    });

    const result = await dedup.dedup(entity, [survivor]);

    expect(result.matched).toBe(true);
    expect(result.matchedLayer).toBe('llmSemantic');
    expect(result.confidence).toBe(0.81);
    expect(result.survivor).toBe(survivor);
    expect(exactName.match).toHaveBeenCalledTimes(1);
    expect(embedding.match).toHaveBeenCalledTimes(1);
    expect(llmSemantic.match).toHaveBeenCalledTimes(1);
  });

  test('short-circuits on first matched layer when shortCircuit: true (default)', async () => {
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000040' as EntityId,
    });
    const survivor = mkEntity({
      id: '0192a000-0000-7000-8000-000000000004' as EntityId,
    });
    const exactName = makeLayerStub({
      kind: 'exactName',
      willMatch: true,
      survivor,
      confidence: 0.95,
    });
    const embedding = makeLayerStub({
      kind: 'embedding',
      willMatch: true,
      survivor,
      confidence: 0.99,
    });
    const llmSemantic = makeLayerStub({
      kind: 'llmSemantic',
      willMatch: true,
      survivor,
      confidence: 1.0,
    });

    // shortCircuit defaults to true
    const dedup = new LayeredDeduplicator({
      exactName,
      embedding,
      llmSemantic,
    });

    const result = await dedup.dedup(entity, [survivor]);

    expect(result.matched).toBe(true);
    expect(result.matchedLayer).toBe('exactName');
    // Downstream layers MUST NOT have been called — short-circuit verified.
    expect(exactName.match).toHaveBeenCalledTimes(1);
    expect(embedding.match).toHaveBeenCalledTimes(0);
    expect(llmSemantic.match).toHaveBeenCalledTimes(0);
    // allLayerResults only carries the executed layer.
    expect(result.allLayerResults).toHaveLength(1);
    expect(result.allLayerResults[0]?.layer).toBe('exactName');
  });

  test('shortCircuit: false runs all layers even after match (first-matched-wins per Example 1 line 323)', async () => {
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000050' as EntityId,
    });
    const survivorA = mkEntity({
      id: '0192a000-0000-7000-8000-000000000005' as EntityId,
      name: 'survivor-A',
    });
    const survivorB = mkEntity({
      id: '0192a000-0000-7000-8000-000000000006' as EntityId,
      name: 'survivor-B',
    });
    const exactName = makeLayerStub({
      kind: 'exactName',
      willMatch: true,
      survivor: survivorA,
      confidence: 0.95,
    });
    const embedding = makeLayerStub({
      kind: 'embedding',
      willMatch: true,
      survivor: survivorB,
      confidence: 0.99,
    });
    const llmSemantic = makeLayerStub({
      kind: 'llmSemantic',
      willMatch: false,
    });

    const dedup = new LayeredDeduplicator({
      exactName,
      embedding,
      llmSemantic,
      shortCircuit: false,
    });

    const result = await dedup.dedup(entity, [survivorA, survivorB]);

    // All three layers ran sequentially (no short-circuit).
    expect(exactName.match).toHaveBeenCalledTimes(1);
    expect(embedding.match).toHaveBeenCalledTimes(1);
    expect(llmSemantic.match).toHaveBeenCalledTimes(1);
    expect(result.allLayerResults).toHaveLength(3);
    // Winner is the FIRST matched layer (per RESEARCH Example 1 line 323:
    // `layerResults.find((r) => r.matched)`), even though embedding has a
    // higher confidence. This is the locked policy.
    expect(result.matched).toBe(true);
    expect(result.matchedLayer).toBe('exactName');
    expect(result.confidence).toBe(0.95);
    expect(result.survivor).toBe(survivorA);
  });

  test('omitted layer slots are skipped', async () => {
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000060' as EntityId,
    });
    const survivor = mkEntity({
      id: '0192a000-0000-7000-8000-000000000007' as EntityId,
    });
    const exactName = makeLayerStub({
      kind: 'exactName',
      willMatch: true,
      survivor,
      confidence: 0.9,
    });

    // Only exactName supplied — embedding + llmSemantic are undefined.
    const dedup = new LayeredDeduplicator({ exactName });

    const result = await dedup.dedup(entity, [survivor]);

    expect(result.matched).toBe(true);
    expect(result.matchedLayer).toBe('exactName');
    expect(exactName.match).toHaveBeenCalledTimes(1);
    // allLayerResults contains only the executed layer.
    expect(result.allLayerResults).toHaveLength(1);
    expect(result.allLayerResults[0]?.layer).toBe('exactName');
  });

  test('runs layers in declared order: exactName → embedding → llmSemantic', async () => {
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000070' as EntityId,
    });
    const exactName = makeLayerStub({ kind: 'exactName', willMatch: false });
    const embedding = makeLayerStub({ kind: 'embedding', willMatch: false });
    const llmSemantic = makeLayerStub({
      kind: 'llmSemantic',
      willMatch: false,
    });

    const dedup = new LayeredDeduplicator({
      exactName,
      embedding,
      llmSemantic,
      shortCircuit: false,
    });

    await dedup.dedup(entity, []);

    // vitest exposes `mock.invocationCallOrder` on vi.fn() mocks. The mock
    // returned by makeLayerStub is a vi.fn() (see fakes.ts:140). Lower call
    // order = called first.
    const exactOrder = (exactName.match as unknown as { mock: { invocationCallOrder: number[] } })
      .mock.invocationCallOrder[0]!;
    const embedOrder = (embedding.match as unknown as { mock: { invocationCallOrder: number[] } })
      .mock.invocationCallOrder[0]!;
    const llmOrder = (llmSemantic.match as unknown as { mock: { invocationCallOrder: number[] } })
      .mock.invocationCallOrder[0]!;

    expect(exactOrder).toBeLessThan(embedOrder);
    expect(embedOrder).toBeLessThan(llmOrder);
  });

  test('returns matched: false when no layer matches above threshold', async () => {
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000080' as EntityId,
    });
    const exactName = makeLayerStub({ kind: 'exactName', willMatch: false });
    const embedding = makeLayerStub({ kind: 'embedding', willMatch: false });
    const llmSemantic = makeLayerStub({
      kind: 'llmSemantic',
      willMatch: false,
    });

    const dedup = new LayeredDeduplicator({
      exactName,
      embedding,
      llmSemantic,
    });

    const result = await dedup.dedup(entity, []);

    expect(result.matched).toBe(false);
    expect(result.matchedLayer).toBeUndefined();
    expect(result.survivor).toBeUndefined();
    expect(result.confidence).toBeUndefined();
    expect(result.allLayerResults).toHaveLength(3);
    expect(result.allLayerResults.every((r) => !r.matched)).toBe(true);
    expect(result.allLayerResults.map((r) => r.layer)).toEqual([
      'exactName',
      'embedding',
      'llmSemantic',
    ]);
  });

  test('Pitfall 1: entity without ontologyClass AND without entityType — returns matched: false + stderr-warn', async () => {
    // Construct entity violating the D-46 precondition: both ontologyClass
    // and entityType are absent. ontologyClass is optional in Entity but
    // entityType is required; we cast through `unknown` to defeat the
    // strict-type guard for the express purpose of testing the runtime
    // defensive check.
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000090' as EntityId,
      ontologyClass: undefined,
      entityType: '' as unknown as string,
    });
    const survivor = mkEntity({
      id: '0192a000-0000-7000-8000-000000000008' as EntityId,
    });
    // Wire all 3 layers as willMatch=true — if the guard fails, one will
    // fire and the test will catch matched: true.
    const exactName = makeLayerStub({
      kind: 'exactName',
      willMatch: true,
      survivor,
      confidence: 0.99,
    });
    const embedding = makeLayerStub({
      kind: 'embedding',
      willMatch: true,
      survivor,
      confidence: 0.99,
    });
    const llmSemantic = makeLayerStub({
      kind: 'llmSemantic',
      willMatch: true,
      survivor,
      confidence: 0.99,
    });

    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const dedup = new LayeredDeduplicator({
      exactName,
      embedding,
      llmSemantic,
    });
    const result = await dedup.dedup(entity, [survivor]);

    // No layer should have been called — the guard returned early.
    expect(exactName.match).toHaveBeenCalledTimes(0);
    expect(embedding.match).toHaveBeenCalledTimes(0);
    expect(llmSemantic.match).toHaveBeenCalledTimes(0);

    expect(result.matched).toBe(false);
    expect(result.allLayerResults).toEqual([]);

    // stderr emission contains the [km-core/dedup] tag.
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((s) => s.includes('[km-core/dedup]'))).toBe(true);
  });
});

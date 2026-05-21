// Phase 40 Plan 06a (PIPE-01): IngestPipeline orchestrator unit tests.
//
// Covers the 10 test cases enumerated in 40-06a-PLAN.md Task 1 <behavior>:
//   - 40-T11: stage order: ingest runs extract → dedup → store → synthesize in order
//   - 40-T12: onPhase observability: callback fires start + done for each executed stage
//   - 40-T13: skipStages synthesize: runs other 3 + records ['synthesize'] in IngestResult.skippedStages
//   - 40-T14: skipStages extract contract: throws when text is non-empty (Pitfall 5)
//   - 40-T15: runStage synthesize: invokes synthesizer.synthesize(survivorIds, { provenance }) standalone
//   - 40-T16: provenance threading: store.putEntity receives the caller-supplied ProvenanceStamp unchanged
//   - 40-T17: IngestResult shape: full shape assertion
//   - 40-T18: provenance required: throws when opts.provenance is omitted
//   - extra: candidate pool per-entity — findByOntologyClass called once per extracted entity
//   - extra: dedup match — store.putEntity called with { ...entity, supersedes: survivor.id }
//
// no-console-log: tests assert via vi.spyOn on the fakes' methods; no console.* in src.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { IngestPipeline } from '../../src/pipeline/IngestPipeline.js';
import { GraphKMStore } from '../../src/index.js';
import { LayeredDeduplicator } from '../../src/dedup/LayeredDeduplicator.js';
import type { Entity } from '../../src/index.js';
import type { EntityId } from '../../src/index.js';
import type { StageName, IngestResult } from '../../src/pipeline/types.js';
import {
  mkEntity,
  makeFakeExtractor,
  makeFakeSynthesizer,
  makeLayerStub,
  PROV,
} from './_helpers/fakes.js';

type Ctx = {
  store: GraphKMStore;
  tmpdir: string;
};

function makeFixture(): Ctx {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-pipeline-test-'));
  const store = new GraphKMStore({
    dbPath: path.join(tmpdir, 'leveldb'),
    exportDir: path.join(tmpdir, 'exports'),
    debounceMs: 0,
  });
  return { store, tmpdir };
}

describe('IngestPipeline (PIPE-01 4-stage orchestrator)', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = makeFixture();
    await ctx.store.open();
  });

  afterEach(async () => {
    await ctx.store.close();
    fs.rmSync(ctx.tmpdir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test('stage order: ingest runs extract → dedup → store → synthesize in order', async () => {
    const calls: string[] = [];

    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000100' as EntityId,
      name: 'E1',
    });

    const extractor = {
      extract: vi.fn(async (_text: string, _domain?: string) => {
        calls.push('extract');
        return [entity];
      }),
    };

    const deduplicator = new LayeredDeduplicator({
      exactName: makeLayerStub({ kind: 'exactName', willMatch: false }),
    });
    const origDedup = deduplicator.dedup.bind(deduplicator);
    vi.spyOn(deduplicator, 'dedup').mockImplementation(async (e, c) => {
      calls.push('dedup');
      return origDedup(e, c);
    });

    vi.spyOn(ctx.store, 'putEntity').mockImplementation(
      async (e: any) => {
        calls.push('store');
        return e.id as EntityId;
      },
    );
    vi.spyOn(ctx.store, 'findByOntologyClass').mockResolvedValue([]);

    const synthesizer = {
      synthesize: vi.fn(async () => {
        calls.push('synthesize');
      }),
    };

    const pipeline = new IngestPipeline(ctx.store, {
      extractor,
      deduplicator,
      synthesizer,
    });

    await pipeline.ingest('some text', { provenance: PROV });

    expect(calls).toEqual(['extract', 'dedup', 'store', 'synthesize']);
  });

  test('onPhase observability: callback fires start + done for each executed stage', async () => {
    const events: Array<{ stage: StageName; status: 'start' | 'done' }> = [];

    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000101' as EntityId,
    });

    const extractor = makeFakeExtractor([entity]);
    const deduplicator = new LayeredDeduplicator({
      exactName: makeLayerStub({ kind: 'exactName', willMatch: false }),
    });
    const synthesizer = makeFakeSynthesizer();

    vi.spyOn(ctx.store, 'findByOntologyClass').mockResolvedValue([]);
    vi.spyOn(ctx.store, 'putEntity').mockResolvedValue(entity.id);

    const pipeline = new IngestPipeline(ctx.store, {
      extractor,
      deduplicator,
      synthesizer,
      onPhase: (e) => events.push({ stage: e.stage, status: e.status }),
    });

    await pipeline.ingest('hello', { provenance: PROV });

    // Two events (start + done) per executed stage, 4 stages.
    expect(events).toEqual([
      { stage: 'extract', status: 'start' },
      { stage: 'extract', status: 'done' },
      { stage: 'dedup', status: 'start' },
      { stage: 'dedup', status: 'done' },
      { stage: 'store', status: 'start' },
      { stage: 'store', status: 'done' },
      { stage: 'synthesize', status: 'start' },
      { stage: 'synthesize', status: 'done' },
    ]);
  });

  test('skipStages synthesize: runs other 3 + records ["synthesize"] in IngestResult.skippedStages', async () => {
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000102' as EntityId,
    });
    const extractor = makeFakeExtractor([entity]);
    const deduplicator = new LayeredDeduplicator({
      exactName: makeLayerStub({ kind: 'exactName', willMatch: false }),
    });
    const synthesizer = makeFakeSynthesizer();

    vi.spyOn(ctx.store, 'findByOntologyClass').mockResolvedValue([]);
    vi.spyOn(ctx.store, 'putEntity').mockResolvedValue(entity.id);

    const pipeline = new IngestPipeline(ctx.store, {
      extractor,
      deduplicator,
      synthesizer,
    });

    const result = await pipeline.ingest('hello', {
      provenance: PROV,
      skipStages: ['synthesize'],
    });

    expect(result.skippedStages).toEqual(['synthesize']);
    expect(result.extractedCount).toBe(1);
    expect(result.storedCount).toBe(1);
    expect(synthesizer.synthesize).not.toHaveBeenCalled();
  });

  test('skipStages extract contract: throws when text is non-empty (Pitfall 5)', async () => {
    const extractor = makeFakeExtractor([]);
    const deduplicator = new LayeredDeduplicator({
      exactName: makeLayerStub({ kind: 'exactName', willMatch: false }),
    });
    const synthesizer = makeFakeSynthesizer();

    const pipeline = new IngestPipeline(ctx.store, {
      extractor,
      deduplicator,
      synthesizer,
    });

    await expect(
      pipeline.ingest('non-empty text', {
        provenance: PROV,
        skipStages: ['extract'],
      }),
    ).rejects.toThrow(/Pitfall 5|empty text/);
  });

  test('runStage synthesize: invokes synthesizer.synthesize(survivorIds, { provenance }) standalone', async () => {
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000103' as EntityId,
    });
    const extractor = makeFakeExtractor([]);
    const deduplicator = new LayeredDeduplicator({
      exactName: makeLayerStub({ kind: 'exactName', willMatch: false }),
    });
    const synthesizer = makeFakeSynthesizer();

    const pipeline = new IngestPipeline(ctx.store, {
      extractor,
      deduplicator,
      synthesizer,
    });

    // No cast — must compile under the 'synthesize' overload.
    await pipeline.runStage('synthesize', [entity.id], { provenance: PROV });

    expect(synthesizer.synthesize).toHaveBeenCalledWith([entity.id], {
      provenance: PROV,
    });
  });

  test('provenance threading: store.putEntity receives the caller-supplied ProvenanceStamp unchanged', async () => {
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000104' as EntityId,
    });
    const extractor = makeFakeExtractor([entity]);
    const deduplicator = new LayeredDeduplicator({
      exactName: makeLayerStub({ kind: 'exactName', willMatch: false }),
    });
    const synthesizer = makeFakeSynthesizer();

    const putSpy = vi
      .spyOn(ctx.store, 'putEntity')
      .mockResolvedValue(entity.id);
    vi.spyOn(ctx.store, 'findByOntologyClass').mockResolvedValue([]);

    const pipeline = new IngestPipeline(ctx.store, {
      extractor,
      deduplicator,
      synthesizer,
    });

    await pipeline.ingest('hello', { provenance: PROV });

    expect(putSpy).toHaveBeenCalledTimes(1);
    const optsArg = putSpy.mock.calls[0][1];
    expect(optsArg).toEqual({ provenance: PROV });
    // Same reference — pipeline must not clone the stamp.
    expect(optsArg!.provenance).toBe(PROV);
  });

  test('IngestResult shape: { extractedCount, mergedCount, storedCount, skippedCount, droppedCount, durations: {...}, skippedStages }', async () => {
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000105' as EntityId,
    });
    const extractor = makeFakeExtractor([entity]);
    const deduplicator = new LayeredDeduplicator({
      exactName: makeLayerStub({ kind: 'exactName', willMatch: false }),
    });
    const synthesizer = makeFakeSynthesizer();

    vi.spyOn(ctx.store, 'findByOntologyClass').mockResolvedValue([]);
    vi.spyOn(ctx.store, 'putEntity').mockResolvedValue(entity.id);

    const pipeline = new IngestPipeline(ctx.store, {
      extractor,
      deduplicator,
      synthesizer,
    });

    const result: IngestResult = await pipeline.ingest('hello', {
      provenance: PROV,
    });

    expect(result).toMatchObject({
      extractedCount: 1,
      mergedCount: 0,
      storedCount: 1,
      skippedCount: 0,
      droppedCount: 0,
      skippedStages: [],
    });
    expect(result.durations).toBeDefined();
    expect(typeof result.durations.extractMs).toBe('number');
    expect(typeof result.durations.dedupMs).toBe('number');
    expect(typeof result.durations.storeMs).toBe('number');
    expect(typeof result.durations.synthesizeMs).toBe('number');
  });

  test('provenance required: throws TypeError-like error when opts.provenance is omitted', async () => {
    const extractor = makeFakeExtractor([]);
    const deduplicator = new LayeredDeduplicator({
      exactName: makeLayerStub({ kind: 'exactName', willMatch: false }),
    });
    const synthesizer = makeFakeSynthesizer();

    const pipeline = new IngestPipeline(ctx.store, {
      extractor,
      deduplicator,
      synthesizer,
    });

    await expect(
      pipeline.ingest('hello', {} as any),
    ).rejects.toThrow(/provenance/);
  });

  test('candidate pool per-entity: store.findByOntologyClass called once per extracted entity with entity.ontologyClass', async () => {
    const e1 = mkEntity({
      id: '0192a000-0000-7000-8000-000000000201' as EntityId,
      name: 'A',
      ontologyClass: 'Component',
    });
    const e2 = mkEntity({
      id: '0192a000-0000-7000-8000-000000000202' as EntityId,
      name: 'B',
      ontologyClass: 'Metric',
    });
    const e3 = mkEntity({
      id: '0192a000-0000-7000-8000-000000000203' as EntityId,
      name: 'C',
      ontologyClass: 'TimeWindow',
    });

    const extractor = makeFakeExtractor([e1, e2, e3]);
    const deduplicator = new LayeredDeduplicator({
      exactName: makeLayerStub({ kind: 'exactName', willMatch: false }),
    });
    const synthesizer = makeFakeSynthesizer();

    const findSpy = vi
      .spyOn(ctx.store, 'findByOntologyClass')
      .mockResolvedValue([]);
    vi.spyOn(ctx.store, 'putEntity').mockImplementation(
      async (e: any) => e.id as EntityId,
    );

    const pipeline = new IngestPipeline(ctx.store, {
      extractor,
      deduplicator,
      synthesizer,
    });

    await pipeline.ingest('hello', { provenance: PROV });

    expect(findSpy).toHaveBeenCalledTimes(3);
    expect(findSpy.mock.calls[0][0]).toBe('Component');
    expect(findSpy.mock.calls[1][0]).toBe('Metric');
    expect(findSpy.mock.calls[2][0]).toBe('TimeWindow');
  });

  test('dedup match: store.putEntity called with { ...entity, supersedes: survivor.id }', async () => {
    const newEntity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000301' as EntityId,
      name: 'New',
    });
    const survivor = mkEntity({
      id: '0192a000-0000-7000-8000-000000000300' as EntityId,
      name: 'OldSurvivor',
    });

    const extractor = makeFakeExtractor([newEntity]);
    const deduplicator = new LayeredDeduplicator({
      exactName: makeLayerStub({
        kind: 'exactName',
        willMatch: true,
        survivor,
        confidence: 0.99,
      }),
    });
    const synthesizer = makeFakeSynthesizer();

    vi.spyOn(ctx.store, 'findByOntologyClass').mockResolvedValue([survivor]);
    const putSpy = vi
      .spyOn(ctx.store, 'putEntity')
      .mockResolvedValue(newEntity.id);

    const pipeline = new IngestPipeline(ctx.store, {
      extractor,
      deduplicator,
      synthesizer,
    });

    const result = await pipeline.ingest('hello', { provenance: PROV });

    expect(result.mergedCount).toBe(1);
    expect(putSpy).toHaveBeenCalledTimes(1);
    const entityArg = putSpy.mock.calls[0][0] as Entity;
    expect(entityArg.supersedes).toBe(survivor.id);
    expect(entityArg.name).toBe('New');
  });
});

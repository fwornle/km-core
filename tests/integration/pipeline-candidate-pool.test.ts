// Phase 40 Plan 06b — IngestPipeline integration: candidate-pool sourcing
// (VALIDATION row 40-T22 + 3 coverage extras).
//
// The pipeline pre-loads a per-entity candidate pool via
//   `store.findByOntologyClass(entity.ontologyClass ?? entity.entityType)`
// per Phase 40 D-46. Phase 39 D-34 makes that store call active-only by
// default — superseded predecessors are filtered out unless the caller passes
// `{ includeSuperseded: true }`, which the pipeline does NOT.
//
// These integration tests exercise the real GraphKMStore find-path (not a
// mock) and assert what the deduplicator actually receives, including the
// 40-T22 active-only invariant that prevents dedup from comparing a new
// entity to its own superseded ancestor.
//
// no-console-log: spies are vitest's `vi.spyOn`; no console.* / stderr writes.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GraphKMStore } from '../../src/index.js';
import { IngestPipeline } from '../../src/pipeline/IngestPipeline.js';
import { LayeredDeduplicator } from '../../src/dedup/LayeredDeduplicator.js';
import type { Entity } from '../../src/index.js';
import type { EntityId } from '../../src/index.js';
import {
  PROV,
  makeFakeExtractor,
  makeFakeSynthesizer,
  makeLayerStub,
  mkEntity,
} from '../unit/_helpers/fakes.js';

type Ctx = {
  store: GraphKMStore;
  tmpdir: string;
};

function makeFixture(): Ctx {
  const tmpdir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'km-core-pipeline-int-pool-'),
  );
  const store = new GraphKMStore({
    dbPath: path.join(tmpdir, 'leveldb'),
    exportDir: path.join(tmpdir, 'exports'),
    debounceMs: 0,
  });
  return { store, tmpdir };
}

describe('IngestPipeline candidate pool (integration — real GraphKMStore)', () => {
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

  test('candidate pool scoped by ontologyClass — entities of different classes are not compared', async () => {
    // Seed two entities, one per class.
    const componentId = '0192a000-0000-7000-8000-0000000000a1' as EntityId;
    await ctx.store.putEntity(
      {
        id: componentId,
        name: 'ComponentSeed',
        entityType: 'Component',
        ontologyClass: 'Component',
      },
      { provenance: PROV },
    );
    const patternId = '0192a000-0000-7000-8000-0000000000a2' as EntityId;
    await ctx.store.putEntity(
      {
        id: patternId,
        name: 'PatternSeed',
        entityType: 'Pattern',
        ontologyClass: 'Pattern',
      },
      { provenance: PROV },
    );

    // Extractor emits a Component — pipeline should only compare it against
    // the Component-class seed, never the Pattern-class one.
    const newComponent = mkEntity({
      id: '0192a000-0000-7000-8000-0000000000a3' as EntityId,
      name: 'AnotherComponent',
      entityType: 'Component',
      ontologyClass: 'Component',
    });

    const extractor = makeFakeExtractor([newComponent]);
    const deduplicator = new LayeredDeduplicator({
      exactName: makeLayerStub({ kind: 'exactName', willMatch: false }),
    });
    const synthesizer = makeFakeSynthesizer();

    // Spy on `dedup` to capture the candidates argument that the pipeline
    // actually feeds the deduplicator.
    const dedupSpy = vi.spyOn(deduplicator, 'dedup');

    const pipeline = new IngestPipeline(ctx.store, {
      extractor,
      deduplicator,
      synthesizer,
    });

    await pipeline.ingest('any text', { provenance: PROV });

    expect(dedupSpy).toHaveBeenCalledTimes(1);
    const candidates = dedupSpy.mock.calls[0][1] as Entity[];
    const candidateIds = candidates.map((c) => c.id);
    expect(candidateIds).toContain(componentId);
    expect(candidateIds).not.toContain(patternId);
  });

  test('candidate pool excludes superseded predecessors by default (Phase 39 D-34 inherited) — active-only candidates', async () => {
    // Seed predecessor A, then explicitly supersede it with B via the store's
    // own D-33 closure (putEntity({ ...B, supersedes: A.id })). After this,
    // findByOntologyClass('Component') should return [B] only — A is
    // superseded (`validUntil` set) and the active-only default filters it
    // out.
    const aId = '0192a000-0000-7000-8000-0000000000b1' as EntityId;
    const aValidFrom = '2026-05-19T00:00:00.000Z';
    await ctx.store.putEntity(
      {
        id: aId,
        name: 'DupTarget',
        entityType: 'Component',
        ontologyClass: 'Component',
        validFrom: aValidFrom,
      },
      { provenance: PROV },
    );

    const bId = '0192a000-0000-7000-8000-0000000000b2' as EntityId;
    const bValidFrom = '2026-05-20T00:00:00.000Z';
    await ctx.store.putEntity(
      {
        id: bId,
        name: 'DupTargetRefined',
        entityType: 'Component',
        ontologyClass: 'Component',
        validFrom: bValidFrom,
        supersedes: aId,
      },
      { provenance: PROV },
    );

    // Direct-store check: active-only default excludes A.
    const activeOnly = await ctx.store.findByOntologyClass('Component');
    const activeIds = activeOnly.map((e) => e.id);
    expect(activeIds).toContain(bId);
    expect(activeIds).not.toContain(aId);

    // Now run the pipeline with a new entity targeting the same name as A.
    // The pipeline should see only B in the candidate pool — A is excluded.
    const newId = '0192a000-0000-7000-8000-0000000000b3' as EntityId;
    const newEntity = mkEntity({
      id: newId,
      name: 'DupTarget',
      entityType: 'Component',
      ontologyClass: 'Component',
      validFrom: '2026-05-21T00:00:00.000Z',
    });

    const extractor = makeFakeExtractor([newEntity]);
    const deduplicator = new LayeredDeduplicator({
      exactName: makeLayerStub({ kind: 'exactName', willMatch: false }),
    });
    const synthesizer = makeFakeSynthesizer();

    const dedupSpy = vi.spyOn(deduplicator, 'dedup');

    const pipeline = new IngestPipeline(ctx.store, {
      extractor,
      deduplicator,
      synthesizer,
    });

    await pipeline.ingest('any text', { provenance: PROV });

    expect(dedupSpy).toHaveBeenCalledTimes(1);
    const candidates = dedupSpy.mock.calls[0][1] as Entity[];
    const candidateIds = candidates.map((c) => c.id);
    expect(candidateIds).toContain(bId);
    expect(candidateIds).not.toContain(aId);
  });

  test('entity with undefined ontologyClass falls back to entityType for pool lookup', async () => {
    // Seed a Component entity (so the lookup-key derivation has something to
    // find).
    const seedId = '0192a000-0000-7000-8000-0000000000c1' as EntityId;
    await ctx.store.putEntity(
      {
        id: seedId,
        name: 'EntityTypeFallbackSeed',
        entityType: 'Component',
        ontologyClass: 'Component',
      },
      { provenance: PROV },
    );

    // Extractor emits an entity with ontologyClass: undefined (only
    // entityType set). The pipeline should fall back to entityType for
    // findByOntologyClass.
    const newEntity = mkEntity({
      id: '0192a000-0000-7000-8000-0000000000c2' as EntityId,
      name: 'NoOntologyClass',
      entityType: 'Component',
      ontologyClass: undefined,
    });

    const extractor = makeFakeExtractor([newEntity]);
    const deduplicator = new LayeredDeduplicator({
      exactName: makeLayerStub({ kind: 'exactName', willMatch: false }),
    });
    const synthesizer = makeFakeSynthesizer();

    const findSpy = vi.spyOn(ctx.store, 'findByOntologyClass');

    const pipeline = new IngestPipeline(ctx.store, {
      extractor,
      deduplicator,
      synthesizer,
    });

    await pipeline.ingest('any text', { provenance: PROV });

    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(findSpy.mock.calls[0][0]).toBe('Component');
    // The candidate pool should include the Component-class seed.
    const candidates = await findSpy.mock.results[0].value;
    expect((candidates as Entity[]).map((c) => c.id)).toContain(seedId);
  });

  test('empty candidate pool — dedup short-circuits to no-match', async () => {
    // Store is empty for the 'Component' class. The pipeline still pre-loads
    // a pool (which will be []) and runs dedup against it; the deduplicator
    // returns { matched: false } and the entity flows through as net-new.
    const newEntity = mkEntity({
      id: '0192a000-0000-7000-8000-0000000000d1' as EntityId,
      name: 'FirstEverComponent',
      entityType: 'Component',
      ontologyClass: 'Component',
    });

    const extractor = makeFakeExtractor([newEntity]);
    const deduplicator = new LayeredDeduplicator({
      exactName: makeLayerStub({ kind: 'exactName', willMatch: false }),
    });
    const synthesizer = makeFakeSynthesizer();

    const dedupSpy = vi.spyOn(deduplicator, 'dedup');

    const pipeline = new IngestPipeline(ctx.store, {
      extractor,
      deduplicator,
      synthesizer,
    });

    const result = await pipeline.ingest('any text', { provenance: PROV });

    expect(dedupSpy).toHaveBeenCalledTimes(1);
    const candidates = dedupSpy.mock.calls[0][1] as Entity[];
    expect(candidates).toEqual([]);

    expect(result.mergedCount).toBe(0);
    expect(result.storedCount).toBe(1);

    // Entity is stored as net-new (no supersedes).
    const stored = await ctx.store.getEntity(newEntity.id);
    expect(stored).toBeDefined();
    expect(stored!.supersedes).toBeUndefined();
  });
});

// Phase 40 Plan 06b — IngestPipeline integration: supersession path (VALIDATION
// rows 40-T20, 40-T21).
//
// Covers two boundary contracts that connect Phase 40's pipeline to Phase 39's
// store, both of which are too low-level to exercise from a pipeline unit
// test (the store is real, not a mock):
//
//   - 40-T20 — D-33 supersession via matched survivor: when the dedup stage
//     matches a previously-stored active entity A, the pipeline calls
//     `store.putEntity({ ...newEntity, supersedes: A.id }, { provenance })`
//     and Phase 39's atomic closure sets `A.validUntil = newEntity.validFrom`
//     and writes the SUPERSEDED_BY edge. `store.getSupersessionChain(newId)`
//     then returns `[A, newEntity]` in validFrom-ascending order.
//
//   - 40-T21 — Phase 39 CR-01 legacy predecessor: when the matched survivor
//     was originally stored on the trusted path with a non-v7 id (a legacy
//     nanoid-shaped string, C's layer-prefixed key, or any backfill stamp),
//     the supersession closure's internal batch MUST carry per-op
//     `skipOntologyCheck: true` for both ops so Phase 1 validation skips
//     `parseEntityId` for the predecessor. Without CR-01 this throws silently
//     and D-33 atomicity breaks. We trigger the path through the full
//     IngestPipeline and assert no throw + predecessor closure happens.
//
// The other two tests in this file are coverage extras that exercise the
// non-match (net-new write) path and the deterministic chain ordering.
//
// no-console-log: this test file uses neither console.* nor any direct
// stderr writes; it asserts via vi spies on store methods.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GraphKMStore } from '../../src/index.js';
import { IngestPipeline } from '../../src/pipeline/IngestPipeline.js';
import { LayeredDeduplicator } from '../../src/dedup/LayeredDeduplicator.js';
import type { Entity, ProvenanceStamp } from '../../src/index.js';
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
    path.join(os.tmpdir(), 'km-core-pipeline-int-supersession-'),
  );
  const store = new GraphKMStore({
    dbPath: path.join(tmpdir, 'leveldb'),
    exportDir: path.join(tmpdir, 'exports'),
    debounceMs: 0,
  });
  return { store, tmpdir };
}

describe('IngestPipeline supersession (integration — real GraphKMStore)', () => {
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

  test('supersedes via matched survivor — predecessor closed atomically (Phase 39 D-33 verified)', async () => {
    // Seed an active survivor A directly via the store (strict path — requires
    // provenance, validates id, runs ontology check). This mirrors what a
    // previous ingest call would have written.
    const survivorId = '0192a000-0000-7000-8000-000000000a01' as EntityId;
    const survivorValidFrom = '2026-05-20T00:00:00.000Z';
    await ctx.store.putEntity(
      {
        id: survivorId,
        name: 'UserAuthService',
        entityType: 'Component',
        ontologyClass: 'Component',
        description: 'Original survivor seeded for supersession test',
        validFrom: survivorValidFrom,
      },
      { provenance: PROV },
    );

    // Sanity: predecessor is active (no validUntil yet).
    const before = await ctx.store.getEntity(survivorId);
    expect(before).toBeDefined();
    expect(before!.validUntil).toBeUndefined();

    // Extractor emits a NEW entity that the dedup layer will match against A.
    const newId = '0192a000-0000-7000-8000-000000000a02' as EntityId;
    const newEntity = mkEntity({
      id: newId,
      name: 'UserAuthService',
      entityType: 'Component',
      ontologyClass: 'Component',
      description: 'Refined replacement — same concept, new description',
      validFrom: '2026-05-21T00:00:00.000Z',
    });

    const extractor = makeFakeExtractor([newEntity]);

    // Stub the exactName layer to force a match against `before`. We do this
    // rather than using a real JaccardNameMatcher because the JaccardMatcher
    // would also match (the names are identical), but stubbing keeps the test
    // immune to per-layer threshold tuning in later phases.
    const deduplicator = new LayeredDeduplicator({
      exactName: makeLayerStub({
        kind: 'exactName',
        willMatch: true,
        survivor: before!,
        confidence: 1.0,
      }),
    });
    const synthesizer = makeFakeSynthesizer();

    const pipeline = new IngestPipeline(ctx.store, {
      extractor,
      deduplicator,
      synthesizer,
    });

    const result = await pipeline.ingest('any text', { provenance: PROV });

    expect(result.mergedCount).toBe(1);
    expect(result.storedCount).toBe(1);

    // Phase 39 D-33 atomic closure: predecessor's validUntil now matches
    // newEntity.validFrom.
    const after = await ctx.store.getEntity(survivorId);
    expect(after).toBeDefined();
    expect(after!.validUntil).toBe(newEntity.validFrom);

    // Phase 39 D-35: getSupersessionChain returns [predecessor, successor]
    // in validFrom-ascending order.
    const chain = await ctx.store.getSupersessionChain(newId);
    expect(chain).toHaveLength(2);
    expect(chain[0].id).toBe(survivorId);
    expect(chain[1].id).toBe(newId);
    expect(chain[1].supersedes).toBe(survivorId);
  });

  test('CR-01 legacy predecessor — dedup match against legacy non-v7 id does NOT throw (Pitfall 2 verified)', async () => {
    // Seed a legacy-id predecessor via the trusted-path bulk-import escape
    // hatch — the same pattern Phase 42's B-side migration uses.
    // `skipOntologyCheck: true` on the per-op widens Phase 1 validation so
    // `parseEntityId` is bypassed for the legacy id. This matches CR-01 +
    // commit 44c1e9b in `.planning/phases/39-entity-data-model/39-REVIEW-FIX.md`.
    const legacyId = 'legacy-nanoid-xyz' as EntityId;
    const legacyValidFrom = '2026-05-19T00:00:00.000Z';
    const legacyProv = {
      provider: 'legacy-migration',
      model: 'backfill',
      runId: 'phase-42-backfill',
      timestamp: legacyValidFrom,
    } as const satisfies ProvenanceStamp;
    await ctx.store.batch([
      {
        type: 'putEntity',
        entity: {
          id: legacyId,
          name: 'LegacyEntity',
          entityType: 'Component',
          ontologyClass: 'Component',
          description: 'Pre-migration legacy entity',
          validFrom: legacyValidFrom,
          metadata: {
            provenance: {
              createdBy: legacyProv,
              lastConfirmedBy: legacyProv,
              confirmationCount: 1,
            },
          },
        },
        skipOntologyCheck: true,
      },
    ]);

    const seeded = await ctx.store.getEntity(legacyId);
    expect(seeded).toBeDefined();
    expect(seeded!.validUntil).toBeUndefined();

    // Extractor emits a new entity, dedup matches against the LEGACY id.
    // The pipeline calls putEntity({ ...newEntity, supersedes: legacyId });
    // Phase 39's closure issues an internal `batch([{ closedOld, ... },
    // { newEntity, ... }])` with both ops carrying `skipOntologyCheck: true`
    // (per CR-01). Without that flag, Phase 1's `parseEntityId('legacy-
    // nanoid-xyz')` throws and D-33 atomicity breaks.
    const newId = '0192a000-0000-7000-8000-000000000b01' as EntityId;
    const newEntity = mkEntity({
      id: newId,
      name: 'NewSuccessor',
      entityType: 'Component',
      ontologyClass: 'Component',
      description: 'Successor to the legacy-id entity',
      validFrom: '2026-05-22T00:00:00.000Z',
    });

    const extractor = makeFakeExtractor([newEntity]);
    const deduplicator = new LayeredDeduplicator({
      exactName: makeLayerStub({
        kind: 'exactName',
        willMatch: true,
        survivor: seeded!,
        confidence: 0.99,
      }),
    });
    const synthesizer = makeFakeSynthesizer();

    const pipeline = new IngestPipeline(ctx.store, {
      extractor,
      deduplicator,
      synthesizer,
    });

    // Must NOT throw — CR-01 widening keeps the closure batch self-consistent
    // when the predecessor id is non-v7.
    await expect(
      pipeline.ingest('any text', { provenance: PROV }),
    ).resolves.toBeDefined();

    // Predecessor's validUntil is set — atomic closure fired through the full
    // pipeline path despite the legacy id.
    const closedLegacy = await ctx.store.getEntity(legacyId);
    expect(closedLegacy).toBeDefined();
    expect(closedLegacy!.validUntil).toBe(newEntity.validFrom);
  });

  test('no-dedup-match — entity stored as net-new with provenance stamped', async () => {
    const entityId = '0192a000-0000-7000-8000-000000000c01' as EntityId;
    const entity = mkEntity({
      id: entityId,
      name: 'BrandNewComponent',
      entityType: 'Component',
      ontologyClass: 'Component',
      description: 'Net-new — no candidates in the store',
    });

    const extractor = makeFakeExtractor([entity]);
    const deduplicator = new LayeredDeduplicator({
      exactName: makeLayerStub({ kind: 'exactName', willMatch: false }),
    });
    const synthesizer = makeFakeSynthesizer();

    const pipeline = new IngestPipeline(ctx.store, {
      extractor,
      deduplicator,
      synthesizer,
    });

    const result = await pipeline.ingest('any text', { provenance: PROV });

    expect(result.storedCount).toBe(1);
    expect(result.mergedCount).toBe(0);

    const stored = await ctx.store.getEntity(entityId);
    expect(stored).toBeDefined();
    expect(stored!.name).toBe('BrandNewComponent');
    // No predecessor → no supersedes.
    expect(stored!.supersedes).toBeUndefined();
    // No predecessor closed → no validUntil.
    expect(stored!.validUntil).toBeUndefined();
    // Provenance came from the caller (PROV) unchanged.
    expect(stored!.metadata?.provenance?.createdBy).toEqual(PROV);
  });

  test('getSupersessionChain returns predecessor + successor in validFrom order', async () => {
    const aId = '0192a000-0000-7000-8000-000000000d01' as EntityId;
    const aValidFrom = '2026-05-18T00:00:00.000Z';
    await ctx.store.putEntity(
      {
        id: aId,
        name: 'ChainPredecessor',
        entityType: 'Component',
        ontologyClass: 'Component',
        description: 'Predecessor for chain-ordering test',
        validFrom: aValidFrom,
      },
      { provenance: PROV },
    );
    const a = (await ctx.store.getEntity(aId))!;

    const bId = '0192a000-0000-7000-8000-000000000d02' as EntityId;
    const bValidFrom = '2026-05-21T00:00:00.000Z';
    const b = mkEntity({
      id: bId,
      name: 'ChainPredecessor',
      entityType: 'Component',
      ontologyClass: 'Component',
      description: 'Successor for chain-ordering test',
      validFrom: bValidFrom,
    });

    const extractor = makeFakeExtractor([b]);
    const deduplicator = new LayeredDeduplicator({
      exactName: makeLayerStub({
        kind: 'exactName',
        willMatch: true,
        survivor: a,
        confidence: 1.0,
      }),
    });
    const synthesizer = makeFakeSynthesizer();

    const pipeline = new IngestPipeline(ctx.store, {
      extractor,
      deduplicator,
      synthesizer,
    });

    await pipeline.ingest('any', { provenance: PROV });

    const chain = await ctx.store.getSupersessionChain(bId);
    expect(chain.map((e) => e.id)).toEqual([aId, bId]);

    // Walking forward from the predecessor's id returns the same ordered chain.
    const fromPredecessor = await ctx.store.getSupersessionChain(aId);
    expect(fromPredecessor.map((e) => e.id)).toEqual([aId, bId]);
  });
});

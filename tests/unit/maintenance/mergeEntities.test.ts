// Phase 41 Plan 05 Task 2: comprehensive behavioral suite for mergeEntities.
//
// 11 tests (A–K) covering: atomic merge happy path, self-loop guard,
// edge-type/metadata preservation, WR-02 single-successor enforcement,
// survivor-not-found, survivor-in-duplicates, empty-duplicateIds,
// segment fold (default + mergeSegments:false), idempotent re-call
// throws, and duplicate-self-loop dedup coverage.
//
// All tests run against a real GraphKMStore against a tmpdir LevelDB.
// No mocks — the atomic-batch contract is the unit under test and must
// be exercised end-to-end through the public store API.
//
// Test fixture conventions:
//   - `makeStoreCtx()` mirrors backfill.test.ts:30-52 — fresh tmpdir per
//     test, debounceMs:0 so persistence flushes immediately.
//   - `cleanup(ctx)` runs in a finally block per test to avoid leaking
//     LevelDB lockfiles across tests on test failure.
//   - PROV is a static ProvenanceStamp; tests that need a different one
//     construct inline.

import { describe, test, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GraphKMStore,
  mintEntityId,
} from '../../../src/index.js';
import type {
  EntityId,
  Entity,
  ProvenanceStamp,
  DescriptionSegment,
} from '../../../src/index.js';
import { mergeEntities } from '../../../src/maintenance/mergeEntities.js';

interface Ctx {
  store: GraphKMStore;
  tmpdir: string;
}

function makeStoreCtx(): Ctx {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-merge-'));
  const store = new GraphKMStore({
    dbPath: path.join(tmpdir, 'leveldb'),
    exportDir: path.join(tmpdir, 'exports'),
    debounceMs: 0,
  });
  return { store, tmpdir };
}

async function cleanup(ctx: Ctx): Promise<void> {
  try {
    await ctx.store.close();
  } catch {
    // store may already be closed
  }
  fs.rmSync(ctx.tmpdir, { recursive: true, force: true });
}

const PROV: ProvenanceStamp = {
  provider: 'mergeEntities-test',
  model: 'phase-41-plan-05',
  runId: 'test-run-static',
  timestamp: '2026-05-22T00:00:00.000Z',
};

/**
 * Seed an Observation via the strict path (D-30 provenance required).
 * Returns the minted EntityId.
 */
async function seedObservation(
  store: GraphKMStore,
  name: string,
  extra?: Partial<Entity>,
): Promise<EntityId> {
  return await store.putEntity(
    {
      name,
      entityType: 'Observation',
      ontologyClass: 'Observation',
      layer: 'evidence',
      description: `seed-${name}`,
      createdAt: '2026-05-22T00:00:00.000Z',
      updatedAt: '2026-05-22T00:00:00.000Z',
      metadata: {},
      ...extra,
    },
    { provenance: PROV },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mergeEntities (Phase 41 Plan 05)', () => {
  // -------------------------------------------------------------------------
  // Test A: Happy path — 1 survivor + 2 duplicates + 3 edges across them.
  // -------------------------------------------------------------------------
  test('A: happy path — closes duplicates, adds SUPERSEDED_BY, rewires edges, appends resolutionHistory, bumps confirmationCount', async () => {
    const ctx = makeStoreCtx();
    try {
      const sId = await seedObservation(ctx.store, 'Survivor');
      const d1Id = await seedObservation(ctx.store, 'Dup1');
      const d2Id = await seedObservation(ctx.store, 'Dup2');
      // Side entities for the edges.
      const aId = await seedObservation(ctx.store, 'AnchorA');
      const bId = await seedObservation(ctx.store, 'AnchorB');
      const cId = await seedObservation(ctx.store, 'AnchorC');

      // A -> D1 (incoming on duplicate D1)
      await ctx.store.addRelation({
        type: 'mentions',
        from: aId,
        to: d1Id,
        createdAt: '2026-05-22T01:00:00.000Z',
      });
      // D1 -> B (outgoing from duplicate D1)
      await ctx.store.addRelation({
        type: 'mentions',
        from: d1Id,
        to: bId,
        createdAt: '2026-05-22T01:01:00.000Z',
      });
      // D2 -> C (outgoing from duplicate D2)
      await ctx.store.addRelation({
        type: 'mentions',
        from: d2Id,
        to: cId,
        createdAt: '2026-05-22T01:02:00.000Z',
      });

      // Snapshot survivor pre-merge to grab initial confirmationCount.
      const sBefore = await ctx.store.getEntity(sId);
      const initialConfCount =
        ((sBefore!.metadata as Record<string, unknown>).provenance as {
          confirmationCount?: number;
        }).confirmationCount ?? 1;

      const result = await mergeEntities(
        ctx.store,
        sId,
        [d1Id, d2Id],
        { provenance: PROV },
      );

      // Duplicates closed.
      const d1After = await ctx.store.getEntity(d1Id);
      const d2After = await ctx.store.getEntity(d2Id);
      expect(d1After!.validUntil).toBeDefined();
      expect(d1After!.validUntil).not.toBe('');
      expect(d2After!.validUntil).toBeDefined();
      expect(d2After!.validUntil).not.toBe('');

      // SUPERSEDED_BY edges D1->S and D2->S exist.
      const sup1 = await ctx.store.findRelations({
        from: d1Id,
        to: sId,
        type: 'SUPERSEDED_BY',
      });
      const sup2 = await ctx.store.findRelations({
        from: d2Id,
        to: sId,
        type: 'SUPERSEDED_BY',
      });
      expect(sup1.length).toBeGreaterThan(0);
      expect(sup2.length).toBeGreaterThan(0);

      // Rewired edges: A->S, S->B, S->C now present.
      const a2s = await ctx.store.findRelations({
        from: aId,
        to: sId,
        type: 'mentions',
      });
      const s2b = await ctx.store.findRelations({
        from: sId,
        to: bId,
        type: 'mentions',
      });
      const s2c = await ctx.store.findRelations({
        from: sId,
        to: cId,
        type: 'mentions',
      });
      expect(a2s.length).toBe(1);
      expect(s2b.length).toBe(1);
      expect(s2c.length).toBe(1);

      // Duplicates have no non-SUPERSEDED_BY edges anymore.
      const d1Out = await ctx.store.findRelations({ from: d1Id });
      const d1OutNonSup = d1Out.filter((r) => r.type !== 'SUPERSEDED_BY');
      expect(d1OutNonSup.length).toBe(0);
      const d1In = await ctx.store.findRelations({ to: d1Id });
      expect(d1In.length).toBe(0);
      const d2Out = await ctx.store.findRelations({ from: d2Id });
      const d2OutNonSup = d2Out.filter((r) => r.type !== 'SUPERSEDED_BY');
      expect(d2OutNonSup.length).toBe(0);

      // Result shape pinned.
      expect(result.edgesRewired).toBe(3);
      expect(result.duplicateIds.length).toBe(2);
      expect(result.survivorId).toBe(sId);

      // ResolutionHistory: 2 records, one per duplicate, with mergedEntityId
      // matching duplicate ids.
      const sAfter = await ctx.store.getEntity(sId);
      const rh = (sAfter!.metadata as Record<string, unknown>)
        .resolutionHistory as Array<{
        mergedEntityId: string;
        mergedBy?: ProvenanceStamp;
      }>;
      expect(rh.length).toBe(2);
      const mergedIds = rh.map((r) => r.mergedEntityId);
      expect(mergedIds).toContain(String(d1Id));
      expect(mergedIds).toContain(String(d2Id));
      // ConfirmationCount bumped by 2.
      const provAfter = (sAfter!.metadata as Record<string, unknown>)
        .provenance as { confirmationCount: number };
      expect(provAfter.confirmationCount).toBe(initialConfCount + 2);
    } finally {
      await cleanup(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Test B: Self-loop guard — D1->S edge collapses on rewire, no S->S.
  // -------------------------------------------------------------------------
  test('B: self-loop guard — edge D1->S becomes self-loop after rewire and is dropped without replacement', async () => {
    const ctx = makeStoreCtx();
    try {
      const sId = await seedObservation(ctx.store, 'Survivor');
      const d1Id = await seedObservation(ctx.store, 'Dup1');

      // D1 -> S edge already exists (would become S->S after rewire).
      await ctx.store.addRelation({
        type: 'refines',
        from: d1Id,
        to: sId,
        createdAt: '2026-05-22T02:00:00.000Z',
      });

      const result = await mergeEntities(
        ctx.store,
        sId,
        [d1Id],
        { provenance: PROV },
      );

      // No self-loop on survivor.
      const sToS = await ctx.store.findRelations({
        from: sId,
        to: sId,
        type: 'refines',
      });
      expect(sToS.length).toBe(0);
      // edgesRewired should be 0 (the only edge was dropped, not rewired).
      expect(result.edgesRewired).toBe(0);
    } finally {
      await cleanup(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Test C: Edge-type + metadata preservation.
  // -------------------------------------------------------------------------
  test('C: edge type and metadata preserved verbatim on rewire', async () => {
    const ctx = makeStoreCtx();
    try {
      const sId = await seedObservation(ctx.store, 'Survivor');
      const d1Id = await seedObservation(ctx.store, 'Dup1');
      const xId = await seedObservation(ctx.store, 'X');

      await ctx.store.addRelation({
        type: 'custom-edge-type',
        from: d1Id,
        to: xId,
        metadata: { weight: 0.85, label: 'test' },
        createdAt: '2026-05-22T03:00:00.000Z',
      });

      await mergeEntities(
        ctx.store,
        sId,
        [d1Id],
        { provenance: PROV },
      );

      const rewired = await ctx.store.findRelations({
        from: sId,
        to: xId,
      });
      // Filter to non-SUPERSEDED_BY edges only.
      const customEdges = rewired.filter(
        (r) => r.type === 'custom-edge-type',
      );
      expect(customEdges.length).toBe(1);
      expect(customEdges[0].type).toBe('custom-edge-type');
      expect(customEdges[0].metadata?.weight).toBe(0.85);
      expect(customEdges[0].metadata?.label).toBe('test');
    } finally {
      await cleanup(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Test D: WR-02 single-successor invariant.
  // -------------------------------------------------------------------------
  test('D: WR-02 single-successor — throws if duplicate already has SUPERSEDED_BY successor; no state mutated', async () => {
    const ctx = makeStoreCtx();
    try {
      const sId = await seedObservation(ctx.store, 'Survivor');
      const d1Id = await seedObservation(ctx.store, 'Dup1');
      const zId = await seedObservation(ctx.store, 'Z');

      // D1 already has a SUPERSEDED_BY edge to Z (some earlier merge).
      await ctx.store.addRelation({
        type: 'SUPERSEDED_BY',
        from: d1Id,
        to: zId,
        createdAt: '2026-05-22T04:00:00.000Z',
      });

      // Capture pre-state.
      const d1Before = await ctx.store.getEntity(d1Id);
      expect(d1Before!.validUntil).toBeUndefined();

      await expect(
        mergeEntities(ctx.store, sId, [d1Id], { provenance: PROV }),
      ).rejects.toThrow(/WR-02 single-successor invariant/);

      // State unchanged: D1.validUntil still undefined.
      const d1After = await ctx.store.getEntity(d1Id);
      expect(d1After!.validUntil).toBeUndefined();
    } finally {
      await cleanup(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Test E: Survivor not found.
  // -------------------------------------------------------------------------
  test('E: throws when survivor not found', async () => {
    const ctx = makeStoreCtx();
    try {
      const d1Id = await seedObservation(ctx.store, 'Dup1');
      const ghost: EntityId = mintEntityId();

      await expect(
        mergeEntities(ctx.store, ghost, [d1Id], { provenance: PROV }),
      ).rejects.toThrow(/mergeEntities: survivor.*not found/);
    } finally {
      await cleanup(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Test F: Survivor in duplicateIds.
  // -------------------------------------------------------------------------
  test('F: throws when survivor appears in duplicateIds', async () => {
    const ctx = makeStoreCtx();
    try {
      const sId = await seedObservation(ctx.store, 'Survivor');

      await expect(
        mergeEntities(ctx.store, sId, [sId], { provenance: PROV }),
      ).rejects.toThrow(/survivor.*cannot be in duplicateIds/);
    } finally {
      await cleanup(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Test G: Empty duplicateIds.
  // -------------------------------------------------------------------------
  test('G: throws when duplicateIds is empty', async () => {
    const ctx = makeStoreCtx();
    try {
      const sId = await seedObservation(ctx.store, 'Survivor');

      await expect(
        mergeEntities(ctx.store, sId, [], { provenance: PROV }),
      ).rejects.toThrow(/must be non-empty/);
    } finally {
      await cleanup(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Test H: Segment fold (default mergeSegments=true).
  // -------------------------------------------------------------------------
  test('H: segment fold — duplicate descriptionSegments merged into survivor', async () => {
    const ctx = makeStoreCtx();
    try {
      const segA: DescriptionSegment = {
        text: 'text-A',
        runId: 'r1',
        provider: 'p1',
        model: 'm1',
        quality: 'standard',
        timestamp: '2026-05-22T05:00:00.000Z',
        confirmations: [],
      };
      const segB: DescriptionSegment = {
        text: 'text-B',
        runId: 'r2',
        provider: 'p2',
        model: 'm2',
        quality: 'standard',
        timestamp: '2026-05-22T05:01:00.000Z',
        confirmations: [],
      };
      const segC: DescriptionSegment = {
        text: 'text-C',
        runId: 'r3',
        provider: 'p3',
        model: 'm3',
        quality: 'standard',
        timestamp: '2026-05-22T05:02:00.000Z',
        confirmations: [],
      };

      const sId = await seedObservation(ctx.store, 'Survivor', {
        metadata: { descriptionSegments: [segA] },
      });
      const d1Id = await seedObservation(ctx.store, 'Dup1', {
        metadata: { descriptionSegments: [segB, segC] },
      });

      const result = await mergeEntities(
        ctx.store,
        sId,
        [d1Id],
        { provenance: PROV },
      );

      const sAfter = await ctx.store.getEntity(sId);
      const segs = (sAfter!.metadata as Record<string, unknown>)
        .descriptionSegments as DescriptionSegment[];
      expect(segs.length).toBe(3);
      const texts = segs.map((s) => s.text);
      expect(texts).toContain('text-A');
      expect(texts).toContain('text-B');
      expect(texts).toContain('text-C');
      expect(result.segmentsMerged).toBe(2);
    } finally {
      await cleanup(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Test I: mergeSegments:false skips the fold.
  // -------------------------------------------------------------------------
  test('I: mergeSegments:false — duplicate descriptionSegments NOT folded', async () => {
    const ctx = makeStoreCtx();
    try {
      const segA: DescriptionSegment = {
        text: 'text-A',
        runId: 'r1',
        provider: 'p1',
        model: 'm1',
        quality: 'standard',
        timestamp: '2026-05-22T06:00:00.000Z',
        confirmations: [],
      };
      const segB: DescriptionSegment = {
        text: 'text-B',
        runId: 'r2',
        provider: 'p2',
        model: 'm2',
        quality: 'standard',
        timestamp: '2026-05-22T06:01:00.000Z',
        confirmations: [],
      };

      const sId = await seedObservation(ctx.store, 'Survivor', {
        metadata: { descriptionSegments: [segA] },
      });
      const d1Id = await seedObservation(ctx.store, 'Dup1', {
        metadata: { descriptionSegments: [segB] },
      });

      const result = await mergeEntities(
        ctx.store,
        sId,
        [d1Id],
        { provenance: PROV, mergeSegments: false },
      );

      const sAfter = await ctx.store.getEntity(sId);
      const segs = (sAfter!.metadata as Record<string, unknown>)
        .descriptionSegments as DescriptionSegment[];
      expect(segs.length).toBe(1);
      expect(segs[0].text).toBe('text-A');
      expect(result.segmentsMerged).toBe(0);
    } finally {
      await cleanup(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Test J: Idempotent re-call throws (WR-02 fires on second call).
  // -------------------------------------------------------------------------
  test('J: re-calling with same args throws — D1 now has SUPERSEDED_BY to S so WR-02 fires', async () => {
    const ctx = makeStoreCtx();
    try {
      const sId = await seedObservation(ctx.store, 'Survivor');
      const d1Id = await seedObservation(ctx.store, 'Dup1');

      await mergeEntities(ctx.store, sId, [d1Id], { provenance: PROV });

      await expect(
        mergeEntities(ctx.store, sId, [d1Id], { provenance: PROV }),
      ).rejects.toThrow(/WR-02 single-successor invariant/);
    } finally {
      await cleanup(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Test K: Duplicate self-loop dedupe — D1->D1 edge handled once.
  // -------------------------------------------------------------------------
  test('K: duplicate self-loop dedupe — D1->D1 edge dropped exactly once after rewire', async () => {
    const ctx = makeStoreCtx();
    try {
      const sId = await seedObservation(ctx.store, 'Survivor');
      const d1Id = await seedObservation(ctx.store, 'Dup1');

      // D1 -> D1 self-loop (returned by BOTH findRelations({from: d1Id})
      // AND findRelations({to: d1Id})). Without identity-key dedup, this
      // would emit TWO removeRelation BatchOps and double-count.
      await ctx.store.addRelation({
        type: 'self-ref',
        from: d1Id,
        to: d1Id,
        createdAt: '2026-05-22T07:00:00.000Z',
      });

      const result = await mergeEntities(
        ctx.store,
        sId,
        [d1Id],
        { provenance: PROV },
      );

      // No S->S edge (would-be self-loop after rewire dropped).
      const selfLoop = await ctx.store.findRelations({
        from: sId,
        to: sId,
        type: 'self-ref',
      });
      expect(selfLoop.length).toBe(0);

      // edgesRewired === 0: the self-loop has no replacement, just removal.
      expect(result.edgesRewired).toBe(0);

      // The original D1->D1 edge is gone from the graph.
      const originalEdge = await ctx.store.findRelations({
        from: d1Id,
        to: d1Id,
        type: 'self-ref',
      });
      expect(originalEdge.length).toBe(0);
    } finally {
      await cleanup(ctx);
    }
  });
});

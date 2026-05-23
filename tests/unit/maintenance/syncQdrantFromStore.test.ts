// Phase 42 Plan 04 Task 2: syncQdrantFromStore (D-52a).
//
// 8 tests covering:
//   1. Embeddings are upserted into a caller-supplied Qdrant client.
//   2. Entities WITHOUT embedding (or with empty arrays) are skipped.
//   3. Idempotency — calling twice produces two upsert calls with identical
//      payloads (overwrite semantics).
//   4. SyncQdrantResult.syncedCount + skippedCount + errors[] reflect reality.
//   5. Client errors are captured per failing batch in errors[] (no abort).
//   6. opts.batchSize controls batching (25 embedded entities, batchSize=10
//      => 3 upsert calls: 10 + 10 + 5).
//   7. Point id is `entity.legacyId.id ?? entity.id` (stable across re-syncs).
//   8. Point payload includes entityType, ontologyClass, name.

import { describe, test, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GraphKMStore } from '../../../src/index.js';
import type {
  Entity,
  EntityId,
  ProvenanceStamp,
} from '../../../src/index.js';
import {
  syncQdrantFromStore,
} from '../../../src/maintenance/syncQdrantFromStore.js';
import type {
  QdrantClient,
  SyncQdrantOptions,
  SyncQdrantResult,
} from '../../../src/maintenance/syncQdrantFromStore.js';

interface Ctx {
  store: GraphKMStore;
  tmpdir: string;
}

function makeStoreCtx(): Ctx {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-syncq-'));
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
    /* already closed */
  }
  fs.rmSync(ctx.tmpdir, { recursive: true, force: true });
}

const PROV: ProvenanceStamp = {
  provider: 'syncQdrantFromStore-test',
  model: 'phase-42-plan-04',
  runId: 'test-run-static',
  timestamp: '2026-05-23T00:00:00.000Z',
};

interface SeedSpec {
  name: string;
  entityType?: string;
  ontologyClass?: string;
  embedding?: number[];
  legacyId?: { system: 'A' | 'B' | 'C'; id: string };
}

async function seed(store: GraphKMStore, spec: SeedSpec): Promise<EntityId> {
  return await store.putEntity(
    {
      name: spec.name,
      entityType: spec.entityType ?? 'Detail',
      ontologyClass: spec.ontologyClass,
      description: `desc-${spec.name}`,
      layer: 'evidence',
      metadata: {},
      embedding: spec.embedding,
      legacyId: spec.legacyId,
    },
    { provenance: PROV },
  );
}

function makeMockQdrantClient(): QdrantClient & {
  upsert: ReturnType<typeof vi.fn>;
} {
  return {
    upsert: vi.fn(async () => undefined),
  };
}

describe('syncQdrantFromStore (Phase 42 D-52a)', () => {
  const ctxs: Ctx[] = [];
  afterEach(async () => {
    while (ctxs.length > 0) {
      await cleanup(ctxs.pop()!);
    }
  });

  test('Test 1: upserts all entities with non-empty embedding', async () => {
    const ctx = makeStoreCtx();
    ctxs.push(ctx);
    await ctx.store.open();

    await seed(ctx.store, { name: 'a', embedding: [0.1, 0.2, 0.3] });
    await seed(ctx.store, { name: 'b', embedding: [0.4, 0.5, 0.6] });

    const qdrant = makeMockQdrantClient();
    const result = await syncQdrantFromStore(ctx.store, {
      qdrantClient: qdrant,
      collection: 'coding',
    });

    expect(qdrant.upsert).toHaveBeenCalledTimes(1);
    const [collection, points] = qdrant.upsert.mock.calls[0];
    expect(collection).toBe('coding');
    expect(points).toHaveLength(2);
    const names = new Set(
      points.map((p: { payload?: { name?: string } }) => p.payload?.name),
    );
    expect(names).toEqual(new Set(['a', 'b']));
    expect(result.syncedCount).toBe(2);
    expect(result.skippedCount).toBe(0);
    expect(result.errors).toEqual([]);
  });

  test('Test 2: entities without embedding (or empty arrays) are skipped', async () => {
    const ctx = makeStoreCtx();
    ctxs.push(ctx);
    await ctx.store.open();

    await seed(ctx.store, { name: 'with-emb', embedding: [0.1, 0.2] });
    await seed(ctx.store, { name: 'no-emb' });
    await seed(ctx.store, { name: 'empty-emb', embedding: [] });

    const qdrant = makeMockQdrantClient();
    const result = await syncQdrantFromStore(ctx.store, {
      qdrantClient: qdrant,
      collection: 'coding',
    });

    expect(qdrant.upsert).toHaveBeenCalledTimes(1);
    const points = qdrant.upsert.mock.calls[0][1];
    expect(points).toHaveLength(1);
    expect(points[0].payload.name).toBe('with-emb');
    expect(result.syncedCount).toBe(1);
    expect(result.skippedCount).toBe(2);
  });

  test('Test 3: idempotency — two calls produce identical-shape payloads', async () => {
    const ctx = makeStoreCtx();
    ctxs.push(ctx);
    await ctx.store.open();

    await seed(ctx.store, { name: 'stable', embedding: [1, 2, 3] });
    const qdrant = makeMockQdrantClient();

    await syncQdrantFromStore(ctx.store, {
      qdrantClient: qdrant,
      collection: 'coding',
    });
    await syncQdrantFromStore(ctx.store, {
      qdrantClient: qdrant,
      collection: 'coding',
    });

    expect(qdrant.upsert).toHaveBeenCalledTimes(2);
    const call1 = qdrant.upsert.mock.calls[0];
    const call2 = qdrant.upsert.mock.calls[1];
    // Same collection name, same single point with identical id+vector+payload.
    expect(call2[0]).toBe(call1[0]);
    expect(call2[1]).toEqual(call1[1]);
  });

  test('Test 4: SyncQdrantResult.syncedCount, skippedCount, errors[] match reality', async () => {
    const ctx = makeStoreCtx();
    ctxs.push(ctx);
    await ctx.store.open();

    await seed(ctx.store, { name: 'a', embedding: [0.1] });
    await seed(ctx.store, { name: 'b', embedding: [0.2] });
    await seed(ctx.store, { name: 'c' }); // skipped

    const qdrant = makeMockQdrantClient();
    const result: SyncQdrantResult = await syncQdrantFromStore(ctx.store, {
      qdrantClient: qdrant,
      collection: 'coding',
    });
    expect(result.syncedCount).toBe(2);
    expect(result.skippedCount).toBe(1);
    expect(result.errors).toEqual([]);
  });

  test('Test 5: per-batch errors are captured; sync continues', async () => {
    const ctx = makeStoreCtx();
    ctxs.push(ctx);
    await ctx.store.open();

    // 25 embedded entities + 1 skipped — with batchSize=10 we get 3 batches.
    for (let i = 0; i < 25; i++) {
      await seed(ctx.store, {
        name: `e${i}`,
        embedding: [i / 25],
      });
    }
    await seed(ctx.store, { name: 'skipped' });

    let callCount = 0;
    const qdrant: QdrantClient & {
      upsert: ReturnType<typeof vi.fn>;
    } = {
      upsert: vi.fn(async (_collection: string) => {
        callCount++;
        if (callCount === 2) {
          throw new Error('simulated network failure');
        }
        return undefined;
      }),
    };

    const result = await syncQdrantFromStore(ctx.store, {
      qdrantClient: qdrant,
      collection: 'coding',
      batchSize: 10,
    });

    expect(qdrant.upsert).toHaveBeenCalledTimes(3);
    // Batch 1 (10) + Batch 3 (5) synced; Batch 2 (10) failed.
    expect(result.syncedCount).toBe(15);
    expect(result.skippedCount).toBe(1);
    expect(result.errors).toHaveLength(10);
    expect(result.errors[0].message).toContain('simulated network failure');
  });

  test('Test 6: opts.batchSize controls batching (25 ents / 10 = 3 calls)', async () => {
    const ctx = makeStoreCtx();
    ctxs.push(ctx);
    await ctx.store.open();

    for (let i = 0; i < 25; i++) {
      await seed(ctx.store, { name: `e${i}`, embedding: [i] });
    }

    const qdrant = makeMockQdrantClient();
    await syncQdrantFromStore(ctx.store, {
      qdrantClient: qdrant,
      collection: 'coding',
      batchSize: 10,
    });

    expect(qdrant.upsert).toHaveBeenCalledTimes(3);
    const batches = qdrant.upsert.mock.calls.map(
      (c: unknown[]) => (c[1] as unknown[]).length,
    );
    expect(batches.sort((a, b) => a - b)).toEqual([5, 10, 10]);
  });

  test('Test 7: point id is legacyId.id when set, else entity.id', async () => {
    const ctx = makeStoreCtx();
    ctxs.push(ctx);
    await ctx.store.open();

    const idA = await seed(ctx.store, {
      name: 'with-legacy',
      embedding: [0.1],
      legacyId: { system: 'B', id: 'mc4flkglue8o7' },
    });
    const idB = await seed(ctx.store, {
      name: 'no-legacy',
      embedding: [0.2],
    });

    const qdrant = makeMockQdrantClient();
    await syncQdrantFromStore(ctx.store, {
      qdrantClient: qdrant,
      collection: 'coding',
    });

    const points = qdrant.upsert.mock.calls[0][1];
    const byName = new Map<string, { id: string | number }>(
      points.map((p: { id: string | number; payload?: { name?: string } }) => [
        p.payload?.name as string,
        { id: p.id },
      ]),
    );
    expect(byName.get('with-legacy')!.id).toBe('mc4flkglue8o7');
    expect(byName.get('no-legacy')!.id).toBe(idB);
    void idA; // referenced for completeness; legacyId path doesn't use idA
  });

  test('Test 8: point payload includes entityType, ontologyClass, name', async () => {
    const ctx = makeStoreCtx();
    ctxs.push(ctx);
    await ctx.store.open();

    await seed(ctx.store, {
      name: 'observe-me',
      entityType: 'Detail',
      ontologyClass: 'Detail',
      embedding: [1, 2, 3],
    });

    const qdrant = makeMockQdrantClient();
    await syncQdrantFromStore(ctx.store, {
      qdrantClient: qdrant,
      collection: 'coding',
    });

    const point = qdrant.upsert.mock.calls[0][1][0];
    expect(point.vector).toEqual([1, 2, 3]);
    expect(point.payload).toMatchObject({
      entityType: 'Detail',
      ontologyClass: 'Detail',
      name: 'observe-me',
    });
  });
});

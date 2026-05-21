// Phase 39 (DATA-01/DATA-02): backfillEntityDataModel tests covering
// D-37 idempotency + D-38 resumability + dryRun + atomic-checkpoint +
// synthetic-provenance + legacyId-propagation + T-39-04-01 path-traversal
// guard.
//
// 9 tests in one describe block (the plan requires "7+"; covering the 8
// verbatim-named test cases plus the path-traversal guard = 9 total).

import { describe, test, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GraphKMStore,
  backfillEntityDataModel,
} from '../../src/index.js';
import type {
  EntityId,
  Entity,
  ProvenanceStamp,
  EntityProvenance,
  BackfillResolver,
} from '../../src/index.js';

interface Ctx {
  store: GraphKMStore;
  tmpdir: string;
  checkpointPath: string;
}

function makeStoreCtx(): Ctx {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-backfill-'));
  const store = new GraphKMStore({
    dbPath: path.join(tmpdir, 'leveldb'),
    exportDir: path.join(tmpdir, 'exports'),
    debounceMs: 0,
  });
  return {
    store,
    tmpdir,
    checkpointPath: path.join(tmpdir, 'backfill.json'),
  };
}

async function cleanup(ctx: Ctx): Promise<void> {
  try {
    await ctx.store.close();
  } catch {
    // store may already be closed
  }
  fs.rmSync(ctx.tmpdir, { recursive: true, force: true });
}

const LEGACY_PROVENANCE: ProvenanceStamp = {
  provider: 'backfill',
  model: 'phase-39',
  runId: 'p39-backfill-test',
  timestamp: '2026-05-20T12:00:00.000Z',
};

const RESOLVER: BackfillResolver = (entity) => ({
  validFrom: entity.createdAt,
  legacyId: { system: 'B', id: String(entity.id) },
});

/**
 * Seed a "legacy" entity via the trusted putEntity path so it lacks
 * `validFrom` AND the auto-assembled EntityProvenance. The trusted
 * path preserves input fields verbatim, so we have to supply
 * `createdAt` ourselves (it's a required field on Entity).
 */
async function seedLegacy(
  store: GraphKMStore,
  id: string,
  extra?: Partial<Entity>,
): Promise<void> {
  await store.putEntity(
    {
      id: id as EntityId,
      name: `legacy-${id}`,
      entityType: 'Component',
      createdAt: '2025-01-15T10:00:00.000Z',
      updatedAt: '2025-01-15T10:00:00.000Z',
      layer: 'evidence',
      description: '',
      metadata: {},
      ...extra,
    },
    { skipOntologyCheck: true },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('backfillEntityDataModel (D-36, D-37, D-38)', () => {
  test('backfill stamps validFrom from resolver on legacy entities (D-37)', async () => {
    const ctx = makeStoreCtx();
    try {
      await seedLegacy(ctx.store, 'nanoid-1');
      await seedLegacy(ctx.store, 'nanoid-2');

      const result = await backfillEntityDataModel(ctx.store, {
        resolver: RESOLVER,
        legacyProvenance: LEGACY_PROVENANCE,
        checkpointPath: ctx.checkpointPath,
      });

      expect(result).toEqual({ scanned: 2, stamped: 2, skipped: 0 });

      const e1 = await ctx.store.getEntity('nanoid-1' as EntityId);
      const e2 = await ctx.store.getEntity('nanoid-2' as EntityId);
      expect(e1!.validFrom).toBe('2025-01-15T10:00:00.000Z');
      expect(e2!.validFrom).toBe('2025-01-15T10:00:00.000Z');
    } finally {
      await cleanup(ctx);
    }
  });

  test('backfill is idempotent — second run stamps 0 (D-37 + Pitfall 5)', async () => {
    const ctx = makeStoreCtx();
    try {
      await seedLegacy(ctx.store, 'nanoid-1');
      await seedLegacy(ctx.store, 'nanoid-2');

      const first = await backfillEntityDataModel(ctx.store, {
        resolver: RESOLVER,
        legacyProvenance: LEGACY_PROVENANCE,
        checkpointPath: ctx.checkpointPath,
      });
      expect(first.stamped).toBe(2);

      const second = await backfillEntityDataModel(ctx.store, {
        resolver: RESOLVER,
        legacyProvenance: LEGACY_PROVENANCE,
        checkpointPath: ctx.checkpointPath,
      });
      expect(second).toEqual({
        scanned: 2,
        stamped: 0 + first.stamped, // checkpoint carries prior stamped count forward
        skipped: 2,
      });
    } finally {
      await cleanup(ctx);
    }
  });

  test('backfill with dryRun:true does NOT mutate store and does NOT write checkpoint (D-38 + Pitfall 4)', async () => {
    const ctx = makeStoreCtx();
    try {
      await seedLegacy(ctx.store, 'nanoid-1');
      await seedLegacy(ctx.store, 'nanoid-2');

      const putSpy = vi.spyOn(ctx.store, 'putEntity');
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      const result = await backfillEntityDataModel(ctx.store, {
        resolver: RESOLVER,
        legacyProvenance: LEGACY_PROVENANCE,
        checkpointPath: ctx.checkpointPath,
        dryRun: true,
      });

      expect(putSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(ctx.checkpointPath)).toBe(false);
      expect(result).toEqual({ scanned: 2, stamped: 0, skipped: 0 });
      // Verify the dry-run intent log fired for both entities
      expect(stderrSpy).toHaveBeenCalledTimes(2);

      const e1 = await ctx.store.getEntity('nanoid-1' as EntityId);
      const e2 = await ctx.store.getEntity('nanoid-2' as EntityId);
      expect(e1!.validFrom).toBeUndefined();
      expect(e2!.validFrom).toBeUndefined();
    } finally {
      await cleanup(ctx);
    }
  });

  test('backfill writes synthetic EntityProvenance with provider:backfill (D-38)', async () => {
    const ctx = makeStoreCtx();
    try {
      await seedLegacy(ctx.store, 'nanoid-prov');

      await backfillEntityDataModel(ctx.store, {
        resolver: RESOLVER,
        legacyProvenance: LEGACY_PROVENANCE,
        checkpointPath: ctx.checkpointPath,
      });

      const e = await ctx.store.getEntity('nanoid-prov' as EntityId);
      const prov = e!.metadata.provenance as EntityProvenance;
      expect(prov).toBeDefined();
      expect(prov.createdBy.provider).toBe('backfill');
      expect(prov.createdBy).toEqual(LEGACY_PROVENANCE);
      expect(prov.lastConfirmedBy).toEqual(LEGACY_PROVENANCE);
      expect(prov.confirmationCount).toBe(1);
    } finally {
      await cleanup(ctx);
    }
  });

  test('backfill propagates resolver-supplied legacyId onto the stamped entity', async () => {
    const ctx = makeStoreCtx();
    try {
      await seedLegacy(ctx.store, 'legacy-nanoid');

      await backfillEntityDataModel(ctx.store, {
        resolver: RESOLVER,
        legacyProvenance: LEGACY_PROVENANCE,
        checkpointPath: ctx.checkpointPath,
      });

      const e = await ctx.store.getEntity('legacy-nanoid' as EntityId);
      expect(e!.legacyId).toBeDefined();
      expect(e!.legacyId!.system).toBe('B');
      expect(e!.legacyId!.id).toBe('legacy-nanoid');
    } finally {
      await cleanup(ctx);
    }
  });

  test('backfill skips entities that already have validFrom without invoking resolver', async () => {
    const ctx = makeStoreCtx();
    try {
      // One entity already has validFrom (pre-existing), one is legacy.
      await seedLegacy(ctx.store, 'has-valid-from', {
        validFrom: '2025-01-01T00:00:00.000Z',
      });
      await seedLegacy(ctx.store, 'no-valid-from');

      const resolverSpy = vi.fn(RESOLVER);

      const result = await backfillEntityDataModel(ctx.store, {
        resolver: resolverSpy,
        legacyProvenance: LEGACY_PROVENANCE,
        checkpointPath: ctx.checkpointPath,
      });

      expect(resolverSpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ scanned: 2, stamped: 1, skipped: 1 });

      // Pre-existing validFrom preserved verbatim
      const pre = await ctx.store.getEntity('has-valid-from' as EntityId);
      expect(pre!.validFrom).toBe('2025-01-01T00:00:00.000Z');
    } finally {
      await cleanup(ctx);
    }
  });

  test('backfill writes atomic checkpoint after each entity write (D-38 + CF-D29)', async () => {
    const ctx = makeStoreCtx();
    try {
      await seedLegacy(ctx.store, 'cp-1');
      await seedLegacy(ctx.store, 'cp-2');
      await seedLegacy(ctx.store, 'cp-3');

      await backfillEntityDataModel(ctx.store, {
        resolver: RESOLVER,
        legacyProvenance: LEGACY_PROVENANCE,
        checkpointPath: ctx.checkpointPath,
      });

      expect(fs.existsSync(ctx.checkpointPath)).toBe(true);
      const raw = fs.readFileSync(ctx.checkpointPath, 'utf-8');
      const cp = JSON.parse(raw) as {
        version: number;
        lastStampedId: string | null;
        stamped: number;
        scanned: number;
      };
      expect(cp.version).toBe(1);
      expect(cp.lastStampedId).not.toBeNull();
      expect(cp.stamped).toBe(3);
      expect(cp.scanned).toBe(3);
    } finally {
      await cleanup(ctx);
    }
  });

  test('backfill rejects checkpointPath containing .. segments (path-traversal mitigation)', async () => {
    const ctx = makeStoreCtx();
    try {
      await seedLegacy(ctx.store, 'pt-1');
      await expect(
        backfillEntityDataModel(ctx.store, {
          resolver: RESOLVER,
          legacyProvenance: LEGACY_PROVENANCE,
          checkpointPath: '../../../etc/passwd',
        }),
      ).rejects.toThrow(/must not contain '\.\.' segments/);
    } finally {
      await cleanup(ctx);
    }
  });

  test('backfill resumes from a pre-existing checkpoint and skips up to lastStampedId (D-38 resumability)', async () => {
    const ctx = makeStoreCtx();
    try {
      // Seed 3 legacy entities; iteration order is graph insertion order
      // (Graphology v0.26).
      await seedLegacy(ctx.store, 'res-1');
      await seedLegacy(ctx.store, 'res-2');
      await seedLegacy(ctx.store, 'res-3');

      // Hand-craft a checkpoint as if we crashed after stamping res-1.
      fs.writeFileSync(
        ctx.checkpointPath,
        JSON.stringify({
          version: 1,
          runId: LEGACY_PROVENANCE.runId,
          lastStampedId: 'res-1',
          scanned: 1,
          stamped: 1,
          skipped: 0,
          updatedAt: '2026-05-20T11:00:00.000Z',
        }),
        'utf-8',
      );

      // Pre-stamp res-1 to match the checkpoint state (otherwise the
      // resume should still skip it via the cursor, but a real resume
      // would have a partially-stamped store).
      await ctx.store.putEntity(
        {
          id: 'res-1' as EntityId,
          name: 'legacy-res-1',
          entityType: 'Component',
          createdAt: '2025-01-15T10:00:00.000Z',
          updatedAt: '2025-01-15T10:00:00.000Z',
          layer: 'evidence',
          description: '',
          metadata: { provenance: {
            createdBy: LEGACY_PROVENANCE,
            lastConfirmedBy: LEGACY_PROVENANCE,
            confirmationCount: 1,
          } },
          validFrom: '2025-01-15T10:00:00.000Z',
        },
        { skipOntologyCheck: true },
      );

      const resolverSpy = vi.fn(RESOLVER);

      const result = await backfillEntityDataModel(ctx.store, {
        resolver: resolverSpy,
        legacyProvenance: LEGACY_PROVENANCE,
        checkpointPath: ctx.checkpointPath,
      });

      // res-1 hit by the cursor-skip; res-2 + res-3 stamped.
      // Stamped includes the prior checkpoint's 1 + 2 fresh = 3 (stamped
      // is cumulative across resumed runs per the BackfillResult contract).
      expect(result.stamped).toBe(3);
      // Resolver invoked only for res-2 + res-3 (NOT for res-1).
      expect(resolverSpy).toHaveBeenCalledTimes(2);

      // CR-02 fix: `skipped` is a PER-RUN counter (not cumulative).
      // This run skipped exactly ONE entity (res-1 hit by cursor); the
      // prior checkpoint's `skipped: 0` is NOT carried forward into the
      // result. Before the CR-02 fix, the result reported `skipped: 1`
      // by coincidence here (prior.skipped was 0, so the double-count
      // didn't surface) — but with a non-zero prior.skipped, the bug
      // would over-report. Asserting the per-run value locks down the
      // intended semantics.
      expect(result.skipped).toBe(1);
      expect(result.scanned).toBe(3);

      const e2 = await ctx.store.getEntity('res-2' as EntityId);
      const e3 = await ctx.store.getEntity('res-3' as EntityId);
      expect(e2!.validFrom).toBeDefined();
      expect(e3!.validFrom).toBeDefined();
    } finally {
      await cleanup(ctx);
    }
  });
});

// Phase 41 Plan 04 (INT-01): unit tests for reprojectFromOnlineStore.
//
// 11 tests covering the <behavior> block of 41-04-PLAN.md:
//   A. Happy path — fresh tmpdir store, jsonExports → Plan 02 fixtures
//   B. Idempotency — second run skips all rows (TOP-LEVEL legacyId scan)
//   C. DryRun — no writes, no checkpoint, no entities visible
//   D. Resume — pre-existing checkpoint skips through cursor
//   E. Path-traversal guard — '..' in checkpointPath throws
//   F. Missing jsonExports dir — warnings[] + stderr warn, NO throw
//   G. Provenance + canonical top-level legacyId + metadata.subsystem
//   H. Aggregation edges — type:'aggregates' from Digest→Observation
//   I. Orphan edge reference — warnings[] + stderr warn, NO throw
//   J. sources.sqlite → throws "not yet supported"
//   K. sources.jsonExports omitted → throws "required"
//
// Test fixture pattern lifted from tests/unit/backfill.test.ts
// (makeStoreCtx + cleanup, real GraphKMStore against tmpdir, per-test
// vi.restoreAllMocks).

import { describe, test, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GraphKMStore,
  type ProvenanceStamp,
  type EntityProvenance,
} from '../../../src/index.js';
import {
  reprojectFromOnlineStore,
  writeReprojectCheckpointAtomic,
} from '../../../src/adapters/online/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to the shared fixtures committed in Plan 02.
const FIXTURE_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  'fixtures',
  'online-export',
);

interface Ctx {
  store: GraphKMStore;
  tmpdir: string;
  checkpointPath: string;
}

function makeStoreCtx(): Ctx {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-reproject-'));
  const store = new GraphKMStore({
    dbPath: path.join(tmpdir, 'leveldb'),
    exportDir: path.join(tmpdir, 'exports'),
    debounceMs: 0,
  });
  return {
    store,
    tmpdir,
    checkpointPath: path.join(tmpdir, 'reproject-cp.json'),
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
  provider: 'reproject-test',
  model: 'phase-41-plan-04',
  runId: 'p41-reproject-test-' + Date.now(),
  timestamp: new Date().toISOString(),
};

// Fixture row counts (mirror tests/fixtures/online-export/*.json committed in Plan 02).
const FIXTURE_COUNTS = {
  observations: 4,
  digests: 2,
  insights: 1,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reprojectFromOnlineStore (INT-01, D-47, CF-D37, CF-D38)', () => {
  test('Test A — happy path writes Observation + Digest + Insight entities + aggregation edges', async () => {
    const ctx = makeStoreCtx();
    try {
      const result = await reprojectFromOnlineStore(ctx.store, {
        sources: { jsonExports: FIXTURE_DIR },
        legacyProvenance: LEGACY_PROVENANCE,
        checkpointPath: ctx.checkpointPath,
      });

      expect(result.written.observations).toBe(FIXTURE_COUNTS.observations);
      expect(result.written.digests).toBe(FIXTURE_COUNTS.digests);
      expect(result.written.insights).toBe(FIXTURE_COUNTS.insights);
      // ≥2 aggregation edges (at least one Digest→Observation + one Insight→Digest).
      expect(result.written.relations).toBeGreaterThanOrEqual(2);
      expect(result.warnings.length).toBe(0);
      expect(result.dryRun).toBe(false);
    } finally {
      await cleanup(ctx);
    }
  });

  test('Test B — idempotency: second run skips all rows (TOP-LEVEL legacyId scan)', async () => {
    const ctx = makeStoreCtx();
    try {
      const first = await reprojectFromOnlineStore(ctx.store, {
        sources: { jsonExports: FIXTURE_DIR },
        legacyProvenance: LEGACY_PROVENANCE,
        checkpointPath: ctx.checkpointPath,
      });
      expect(first.written.observations).toBe(FIXTURE_COUNTS.observations);

      // Count entity nodes in the store after the first run.
      const obsAfter1 = await ctx.store.findByOntologyClass('Observation');
      const digAfter1 = await ctx.store.findByOntologyClass('Digest');
      const insAfter1 = await ctx.store.findByOntologyClass('Insight');
      const totalAfter1 =
        obsAfter1.length + digAfter1.length + insAfter1.length;

      const second = await reprojectFromOnlineStore(ctx.store, {
        sources: { jsonExports: FIXTURE_DIR },
        legacyProvenance: LEGACY_PROVENANCE,
        checkpointPath: ctx.checkpointPath,
      });

      // Second run: NOTHING new written (idempotency); EVERYTHING skipped.
      expect(second.written.observations).toBe(0);
      expect(second.written.digests).toBe(0);
      expect(second.written.insights).toBe(0);
      expect(second.skipped.observations).toBe(FIXTURE_COUNTS.observations);
      expect(second.skipped.digests).toBe(FIXTURE_COUNTS.digests);
      expect(second.skipped.insights).toBe(FIXTURE_COUNTS.insights);

      // Store entity count unchanged.
      const obsAfter2 = await ctx.store.findByOntologyClass('Observation');
      const digAfter2 = await ctx.store.findByOntologyClass('Digest');
      const insAfter2 = await ctx.store.findByOntologyClass('Insight');
      const totalAfter2 =
        obsAfter2.length + digAfter2.length + insAfter2.length;
      expect(totalAfter2).toBe(totalAfter1);
    } finally {
      await cleanup(ctx);
    }
  });

  test('Test C — dryRun: no entities written, no checkpoint file created', async () => {
    const ctx = makeStoreCtx();
    try {
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      const result = await reprojectFromOnlineStore(ctx.store, {
        sources: { jsonExports: FIXTURE_DIR },
        legacyProvenance: LEGACY_PROVENANCE,
        checkpointPath: ctx.checkpointPath,
        dryRun: true,
      });

      expect(result.written.observations).toBe(0);
      expect(result.written.digests).toBe(0);
      expect(result.written.insights).toBe(0);
      expect(result.dryRun).toBe(true);

      // No entities visible in the store.
      const obs = await ctx.store.findByOntologyClass('Observation');
      expect(obs).toEqual([]);
      const digs = await ctx.store.findByOntologyClass('Digest');
      expect(digs).toEqual([]);
      const ins = await ctx.store.findByOntologyClass('Insight');
      expect(ins).toEqual([]);

      // No checkpoint file written.
      expect(fs.existsSync(ctx.checkpointPath)).toBe(false);

      // Dry-run intent logs fired (≥1 per row).
      expect(stderrSpy.mock.calls.length).toBeGreaterThanOrEqual(
        FIXTURE_COUNTS.observations,
      );
    } finally {
      await cleanup(ctx);
    }
  });

  test('Test D — resume: pre-existing checkpoint skips up to lastProcessedSourceId', async () => {
    const ctx = makeStoreCtx();
    try {
      // Read observation fixtures to discover the SECOND observation's id —
      // we'll write a checkpoint pinning the cursor at that id.
      const observationsRaw = fs.readFileSync(
        path.join(FIXTURE_DIR, 'observations.json'),
        'utf-8',
      );
      const observations = JSON.parse(observationsRaw) as Array<{
        id: string;
      }>;
      const secondRowId = observations[1].id;

      // Hand-author a checkpoint matching the current runId so resume
      // activates. (resume is gated by runId equality to defend against
      // stale checkpoints from aborted earlier runs.)
      await writeReprojectCheckpointAtomic(ctx.checkpointPath, {
        version: 1,
        runId: LEGACY_PROVENANCE.runId,
        lastProcessedSourceId: secondRowId,
        lastProcessedTable: 'observations',
        scanned: { observations: 2, digests: 0, insights: 0 },
        written: { observations: 2, digests: 0, insights: 0, relations: 0 },
        skipped: { observations: 0, digests: 0, insights: 0 },
        updatedAt: new Date().toISOString(),
      });

      const result = await reprojectFromOnlineStore(ctx.store, {
        sources: { jsonExports: FIXTURE_DIR },
        legacyProvenance: LEGACY_PROVENANCE,
        checkpointPath: ctx.checkpointPath,
      });

      // Rows 0 and 1 (up to and including the cursor) should be skipped;
      // rows 2..N should be written.
      expect(result.skipped.observations).toBe(2);
      expect(result.written.observations).toBe(
        FIXTURE_COUNTS.observations - 2,
      );
      // Digests + insights pass freely (their table comes after observations
      // and the cursor was in observations).
      expect(result.written.digests).toBe(FIXTURE_COUNTS.digests);
      expect(result.written.insights).toBe(FIXTURE_COUNTS.insights);
    } finally {
      await cleanup(ctx);
    }
  });

  test('Test E — path-traversal guard rejects checkpointPath containing .. segments', async () => {
    const ctx = makeStoreCtx();
    try {
      await expect(
        reprojectFromOnlineStore(ctx.store, {
          sources: { jsonExports: FIXTURE_DIR },
          legacyProvenance: LEGACY_PROVENANCE,
          checkpointPath: '../etc/passwd',
        }),
      ).rejects.toThrow(/checkpointPath must not contain '\.\.' segments/);
    } finally {
      await cleanup(ctx);
    }
  });

  test('Test F — missing jsonExports directory pushes warning, does NOT throw', async () => {
    const ctx = makeStoreCtx();
    try {
      const nonExistentDir = path.join(ctx.tmpdir, 'does-not-exist-anywhere');
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      const result = await reprojectFromOnlineStore(ctx.store, {
        sources: { jsonExports: nonExistentDir },
        legacyProvenance: LEGACY_PROVENANCE,
        checkpointPath: ctx.checkpointPath,
      });

      // No entities written (no source data).
      expect(result.written.observations).toBe(0);
      expect(result.written.digests).toBe(0);
      expect(result.written.insights).toBe(0);

      // Warnings: one per missing source file (3 total).
      const missingWarnings = result.warnings.filter((w) =>
        /missing-source-file/.test(w),
      );
      expect(missingWarnings.length).toBeGreaterThanOrEqual(1);

      // stderr emits the human-readable "source file ... not found" message.
      const stderrCalls = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .join('\n');
      expect(stderrCalls).toMatch(/source file .* not found; treating as empty/);
    } finally {
      await cleanup(ctx);
    }
  });

  test('Test G — provenance + canonical TOP-LEVEL legacyId stamping', async () => {
    const ctx = makeStoreCtx();
    try {
      await reprojectFromOnlineStore(ctx.store, {
        sources: { jsonExports: FIXTURE_DIR },
        legacyProvenance: LEGACY_PROVENANCE,
        checkpointPath: ctx.checkpointPath,
      });

      const observations = await ctx.store.findByOntologyClass('Observation');
      expect(observations.length).toBe(FIXTURE_COUNTS.observations);

      // Pick any one observation and assert the canonical placement.
      const entity = observations[0];
      const prov = entity.metadata.provenance as EntityProvenance;
      expect(prov).toBeDefined();
      expect(prov.createdBy.runId).toBe(LEGACY_PROVENANCE.runId);
      expect(prov.lastConfirmedBy.runId).toBe(LEGACY_PROVENANCE.runId);
      // Top-level legacyId — NOT under metadata.
      expect(entity.legacyId).toBeDefined();
      // Direct dotted-access form for the canonical CF-D37 placement check
      // — `entity.legacyId.system === 'A'` is the verbatim shape asserted
      // by 41-04-PLAN.md acceptance criteria.
      const lid = entity.legacyId as { system: 'A' | 'B' | 'C'; id: string };
      expect(lid.system === 'A').toBe(true);
      expect(lid.id.length).toBeGreaterThan(0);
      expect(entity.legacyId!.system).toBe('A');
      // The id is the source row's id (mapper-stamped per Plan 02).
      expect(typeof entity.legacyId!.id).toBe('string');
      expect(entity.legacyId!.id.length).toBeGreaterThan(0);
      // Subsystem discriminator is SEPARATE — on metadata, not on legacyId.
      expect(entity.metadata.subsystem).toBe('online');
    } finally {
      await cleanup(ctx);
    }
  });

  test("Test H — aggregation edges type:'aggregates' link Digest→Observation", async () => {
    const ctx = makeStoreCtx();
    try {
      await reprojectFromOnlineStore(ctx.store, {
        sources: { jsonExports: FIXTURE_DIR },
        legacyProvenance: LEGACY_PROVENANCE,
        checkpointPath: ctx.checkpointPath,
      });

      const edges = await ctx.store.findRelations({ type: 'aggregates' });
      expect(edges.length).toBeGreaterThanOrEqual(2);

      // Resolve a digest entity and assert at least one outgoing aggregates
      // edge lands on a stored Observation EntityId.
      const digests = await ctx.store.findByOntologyClass('Digest');
      expect(digests.length).toBeGreaterThan(0);
      const observations = await ctx.store.findByOntologyClass('Observation');
      const observationIds = new Set(observations.map((e) => String(e.id)));

      let foundDigestToObs = false;
      for (const edge of edges) {
        const fromIsDigest = digests.some((d) => String(d.id) === String(edge.from));
        const toIsObs = observationIds.has(String(edge.to));
        if (fromIsDigest && toIsObs) {
          foundDigestToObs = true;
          break;
        }
      }
      expect(foundDigestToObs).toBe(true);
    } finally {
      await cleanup(ctx);
    }
  });

  test('Test I — orphan edge reference pushes warning, does NOT throw', async () => {
    const ctx = makeStoreCtx();
    try {
      // Build a per-test tmpdir fixture set so we don't mutate the shared
      // observations.json. Copy observations + digests + insights, then
      // remove the observation referenced by digest[0].observationIds[0]
      // so the dangling reference triggers the orphan-warning path.
      const altFixtureDir = path.join(ctx.tmpdir, 'orphan-fixtures');
      fs.mkdirSync(altFixtureDir, { recursive: true });

      const observationsRaw = fs.readFileSync(
        path.join(FIXTURE_DIR, 'observations.json'),
        'utf-8',
      );
      const digestsRaw = fs.readFileSync(
        path.join(FIXTURE_DIR, 'digests.json'),
        'utf-8',
      );
      const insightsRaw = fs.readFileSync(
        path.join(FIXTURE_DIR, 'insights.json'),
        'utf-8',
      );

      const observations = JSON.parse(observationsRaw) as Array<{
        id: string;
      }>;
      const digests = JSON.parse(digestsRaw) as Array<{
        observationIds: string[];
      }>;

      // Drop the first observation that digest[0] references — that ref
      // becomes orphan on reproject.
      const droppedId = digests[0].observationIds[0];
      const filteredObservations = observations.filter(
        (o) => o.id !== droppedId,
      );

      fs.writeFileSync(
        path.join(altFixtureDir, 'observations.json'),
        JSON.stringify(filteredObservations, null, 2),
        'utf-8',
      );
      fs.writeFileSync(
        path.join(altFixtureDir, 'digests.json'),
        digestsRaw,
        'utf-8',
      );
      fs.writeFileSync(
        path.join(altFixtureDir, 'insights.json'),
        insightsRaw,
        'utf-8',
      );

      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      const result = await reprojectFromOnlineStore(ctx.store, {
        sources: { jsonExports: altFixtureDir },
        legacyProvenance: LEGACY_PROVENANCE,
        checkpointPath: ctx.checkpointPath,
      });

      // Did NOT throw — observations one short, digests + insights still wrote.
      expect(result.written.observations).toBe(
        FIXTURE_COUNTS.observations - 1,
      );
      expect(result.written.digests).toBe(FIXTURE_COUNTS.digests);

      // Orphan-edge warning surfaced.
      const orphanWarnings = result.warnings.filter((w) =>
        /orphan-edge-ref/.test(w),
      );
      expect(orphanWarnings.length).toBeGreaterThanOrEqual(1);

      // stderr emits the orphan reference message.
      const stderrText = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .join('\n');
      expect(stderrText).toMatch(/references unknown observation/);
    } finally {
      await cleanup(ctx);
    }
  });

  test('Test J — sources.sqlite throws "not yet supported in Phase 41"', async () => {
    const ctx = makeStoreCtx();
    try {
      await expect(
        reprojectFromOnlineStore(ctx.store, {
          sources: { sqlite: '/tmp/anything.db' },
          legacyProvenance: LEGACY_PROVENANCE,
          checkpointPath: ctx.checkpointPath,
        }),
      ).rejects.toThrow(/sources\.sqlite is not yet supported/);
    } finally {
      await cleanup(ctx);
    }
  });

  test('Test K — sources.jsonExports required throws when both keys absent', async () => {
    const ctx = makeStoreCtx();
    try {
      await expect(
        reprojectFromOnlineStore(ctx.store, {
          sources: {},
          legacyProvenance: LEGACY_PROVENANCE,
          checkpointPath: ctx.checkpointPath,
        }),
      ).rejects.toThrow(/sources\.jsonExports is required/);
    } finally {
      await cleanup(ctx);
    }
  });
});

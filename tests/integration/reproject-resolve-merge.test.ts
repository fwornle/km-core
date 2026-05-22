// Phase 41 Plan 07 Task 2 — end-to-end integration test exercising the
// full Phase 41 deliverable against synthetic fixtures + the live Plan 01
// ontology directory.
//
// This file pins ROADMAP Phase 41 SC#1-4 with goal-backward assertions:
//
//   SC#1 (typed-ontology-class query API works against reprojected entities)
//        → Test 1 + Test 7
//   SC#2 (zero hot-path impact on A; reproject is read-only against A's
//        writer; SQLite untouched)
//        → Test 2 (structural fixture-shape assertion — sources.jsonExports
//          is the ONLY supported path per Plan 04, so a writer cannot have
//          been opened)
//   SC#3 (cross-batch duplicates collapse through resolveEntities)
//        → Test 3 + Test 6 (dryRun planning + idempotency)
//   SC#4 (resolveEntities runs against adapter-fronted graph identically to
//        a B/C-populated graph — verified by Test 3 against the
//        reproject-populated store)
//        → Test 4 (re-affirmation block; same code path as Test 3)
//
// Fixture pattern: per-test makeFixture() + tmpdir GraphKMStore +
// beforeEach/afterEach open/close (mirrors tests/integration/
// pipeline-supersession.test.ts). The store is constructed with the LIVE
// km-core/ontology/ dir so LearningArtifact subclass resolution works
// inside resolveEntities (Plan 01 + Plan 06 default-class walk).

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  GraphKMStore,
  reprojectFromOnlineStore,
  resolveEntities,
} from '../../src/index.js';
import type {
  Entity,
  ProvenanceStamp,
} from '../../src/index.js';
import type {
  LLMSemanticLayer,
  MatchResult,
} from '../../src/dedup/types.js';

interface Ctx {
  store: GraphKMStore;
  tmpdir: string;
}

/**
 * Locate the live Plan 01 ontology dir (km-core/ontology/) so the
 * GraphKMStore's registry resolves LearningArtifact subclasses
 * (Observation/Digest/Insight) at scan time.
 */
function liveOntologyDir(): string {
  // tests/integration/reproject-resolve-merge.test.ts → km-core/ontology/
  return path.resolve(import.meta.dirname, '..', '..', 'ontology');
}

/** Path to the Plan 02 fixture export dir (3 files: observations/digests/insights). */
function fixtureExportDir(): string {
  return path.resolve(import.meta.dirname, '..', 'fixtures', 'online-export');
}

function makeFixture(): Ctx {
  const tmpdir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'km-core-reproject-resolve-merge-'),
  );
  const store = new GraphKMStore({
    dbPath: path.join(tmpdir, 'leveldb'),
    exportDir: path.join(tmpdir, 'exports'),
    debounceMs: 0,
    ontologyDir: liveOntologyDir(),
  });
  return { store, tmpdir };
}

const PROV: ProvenanceStamp = {
  provider: 'reproject-resolve-merge-test',
  model: 'phase-41-plan-07',
  runId: 'test-run-' + String(Date.now()),
  timestamp: '2026-05-22T00:00:00.000Z',
};

/**
 * The deliberate duplicate pair in `tests/fixtures/online-export/
 * observations.json` (per Plan 02 Task 1 spec) is fixture-obs-0001 +
 * fixture-obs-0002 — both share the same Intent/Approach/Result with
 * trivial whitespace differences. After mapping through
 * `mapObservationRow`, both Entities share the same `name` (first non-
 * empty line of summary). The mock matcher returns the OTHER member of
 * the pair as the survivor when called with one as the subject.
 *
 * Implementation note: resolveEntities' defensive reverse-lookup
 * (`lookupSurvivorInCandidatePool`) filters candidates by both
 * `name === survivor.name` AND `description === survivor.description`
 * where the candidate-pool descriptions are 200-char truncated
 * (EntitySummary contract). To make the lookup succeed for this
 * fixture (whose full descriptions exceed 200 chars), the mock returns
 * a survivor object whose `description` is the 200-char-truncated
 * version of the matched candidate — exactly what a real LLM-backed
 * matcher would surface, since its prompts are built from the
 * truncated EntitySummary entries.
 */
function makeDeliberateDuplicateMatcher(
  legacyIdSurvivor: string,
  legacyIdDuplicate: string,
): LLMSemanticLayer & { match: ReturnType<typeof vi.fn> } {
  return {
    threshold: 0.7,
    match: vi.fn(async (subject: Entity, candidates: Entity[]) => {
      const subjectLegacy = subject.legacyId?.id;
      const buildSurvivor = (other: Entity): Entity => ({
        ...other,
        // Surface the 200-char truncated description — matches what
        // EntitySummary stores in the candidate pool and lets the
        // defensive name+description reverse-lookup succeed.
        description: (other.description ?? '').slice(0, 200),
      });
      // Match only when subject is one half of the deliberate pair AND
      // the OTHER half is present in the candidate pool.
      if (subjectLegacy === legacyIdSurvivor) {
        const other = candidates.find(
          (c) => c.legacyId?.id === legacyIdDuplicate,
        );
        if (other !== undefined) {
          return {
            matched: true,
            survivor: buildSurvivor(other),
            confidence: 0.95,
          } satisfies MatchResult;
        }
      }
      if (subjectLegacy === legacyIdDuplicate) {
        const other = candidates.find(
          (c) => c.legacyId?.id === legacyIdSurvivor,
        );
        if (other !== undefined) {
          return {
            matched: true,
            survivor: buildSurvivor(other),
            confidence: 0.95,
          } satisfies MatchResult;
        }
      }
      return { matched: false, confidence: 0 } satisfies MatchResult;
    }),
  };
}

/** The deliberate duplicate pair identifiers (per fixture inspection). */
const DUP_OBS_A = 'fixture-obs-0001-aaaa-aaaa-aaaaaaaaaaaa';
const DUP_OBS_B = 'fixture-obs-0002-bbbb-bbbb-bbbbbbbbbbbb';

describe('reproject → resolveEntities → mergeEntities end-to-end (Phase 41 Plan 07 SC#1-4)', () => {
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

  // ─────────────────────────────────────────────────────────────────
  // Test 1 — SC#1: typed ontology classes
  // ─────────────────────────────────────────────────────────────────
  test('SC#1 — reprojected entities query by ontology class with top-level legacyId.system === "A" and metadata.subsystem === "online"', async () => {
    const result = await reprojectFromOnlineStore(ctx.store, {
      sources: { jsonExports: fixtureExportDir() },
      legacyProvenance: PROV,
      checkpointPath: path.join(ctx.tmpdir, 'reproject-checkpoint.json'),
    });
    expect(result.scanned.observations).toBeGreaterThanOrEqual(1);
    expect(result.scanned.digests).toBeGreaterThanOrEqual(1);
    expect(result.scanned.insights).toBeGreaterThanOrEqual(1);

    // Typed-class query surface — the SC#1 acceptance shape.
    const observations = await ctx.store.findByOntologyClass('Observation');
    const digests = await ctx.store.findByOntologyClass('Digest');
    const insights = await ctx.store.findByOntologyClass('Insight');

    expect(observations.length).toBeGreaterThanOrEqual(1);
    expect(digests.length).toBeGreaterThanOrEqual(1);
    expect(insights.length).toBeGreaterThanOrEqual(1);

    // Every observation carries the canonical top-level legacyId placement
    // (CF-D37) — `entity.legacyId.system === 'A'` at the TOP LEVEL of the
    // Entity (NOT under entity.metadata.legacyId). Plus the separate
    // metadata.subsystem === 'online' discriminator.
    for (const entity of observations) {
      expect(entity.ontologyClass).toBe('Observation');
      // Pinning the canonical TOP-LEVEL placement — readers asserting
      // `entity.legacyId.system === 'A'` is the verbatim acceptance shape.
      const legacyId = entity.legacyId;
      expect(legacyId).toBeDefined();
      expect(legacyId!.system).toBe('A');
      expect(typeof legacyId!.id).toBe('string');
      expect(legacyId!.id.length).toBeGreaterThan(0);
      const subsystem = (entity.metadata as Record<string, unknown> | undefined)?.subsystem;
      expect(subsystem).toBe('online');
    }
    for (const entity of digests) {
      expect(entity.ontologyClass).toBe('Digest');
      expect(entity.legacyId?.system).toBe('A');
      const subsystem = (entity.metadata as Record<string, unknown> | undefined)?.subsystem;
      expect(subsystem).toBe('online');
    }
    for (const entity of insights) {
      expect(entity.ontologyClass).toBe('Insight');
      expect(entity.legacyId?.system).toBe('A');
      const subsystem = (entity.metadata as Record<string, unknown> | undefined)?.subsystem;
      expect(subsystem).toBe('online');
    }
  });

  // ─────────────────────────────────────────────────────────────────
  // Test 2 — SC#2: read-only against A's writer (structural assertion)
  // ─────────────────────────────────────────────────────────────────
  test('SC#2 — fixture source dir contains only JSON files (no SQLite); reproject cannot have opened a writer', () => {
    // SC#2 ("zero hot-path impact on A") is met by construction in Plan 04:
    // `reprojectFromOnlineStore` implements only the `sources.jsonExports`
    // path; `sources.sqlite` throws "not yet supported in Phase 41". We
    // confirm STRUCTURALLY here: the path we hand reproject contains ONLY
    // .json files, so even if Plan 04 wanted to open a SQLite writer there's
    // nothing to open.
    const dir = fixtureExportDir();
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const fileNames = entries
      .filter((e) => e.isFile())
      .map((e) => e.name);
    // At least one .json file (the deliberate fixture).
    expect(fileNames.some((n) => n.endsWith('.json'))).toBe(true);
    // ZERO .db / .sqlite / .sqlite3 / -wal / -shm files — reproject's
    // SQLite branch is structurally inaccessible against this dir.
    const dbLike = fileNames.filter((n) =>
      /\.(db|sqlite|sqlite3)$|-(wal|shm)$/.test(n),
    );
    expect(dbLike).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────
  // Test 3 — SC#3: cross-batch duplicates collapse via resolveEntities
  // ─────────────────────────────────────────────────────────────────
  test('SC#3 — deliberate observation duplicate pair collapses through resolveEntities; superseded entity excluded from active-only query', async () => {
    // Reproject the fixture into the store.
    await reprojectFromOnlineStore(ctx.store, {
      sources: { jsonExports: fixtureExportDir() },
      legacyProvenance: PROV,
      checkpointPath: path.join(ctx.tmpdir, 'reproject-checkpoint.json'),
    });

    const before = await ctx.store.findByOntologyClass('Observation');
    const beforeN = before.length;
    expect(beforeN).toBeGreaterThanOrEqual(2);

    // Build the mock matcher that returns the OTHER duplicate as survivor
    // when subject is one of the deliberate pair.
    const matcher = makeDeliberateDuplicateMatcher(DUP_OBS_A, DUP_OBS_B);

    const result = await resolveEntities(ctx.store, {
      llmMatcher: matcher,
      provenance: PROV,
      classes: ['Observation'],
      dryRun: false,
    });

    expect(result.dryRun).toBe(false);
    expect(result.merges.length).toBe(1);
    expect(result.merges[0].ontologyClass).toBe('Observation');
    expect(result.merges[0].confidence).toBe(0.95);

    // Active-only post-merge: one duplicate is now superseded, so
    // active-class query returns N-1.
    const after = await ctx.store.findByOntologyClass('Observation');
    expect(after.length).toBe(beforeN - 1);

    // The survivor's supersession chain now includes the duplicate.
    const survivorId = result.merges[0].survivorId;
    const duplicateId = result.merges[0].duplicateId;
    const chain = await ctx.store.getSupersessionChain(duplicateId);
    const idsInChain = chain.map((e) => e.id);
    expect(idsInChain).toContain(survivorId);
    expect(idsInChain).toContain(duplicateId);
  });

  // ─────────────────────────────────────────────────────────────────
  // Test 4 — SC#4: resolveEntities runs against adapter-fronted graph
  // ─────────────────────────────────────────────────────────────────
  test('SC#4 — resolveEntities operates identically against an adapter-populated GraphKMStore (re-affirms Test 3 path is the SC#4 contract)', async () => {
    // SC#4 is verified by construction in Test 3 — the store at that point
    // was populated EXCLUSIVELY by `reprojectFromOnlineStore` (the adapter),
    // and resolveEntities ran against it without any special-casing. This
    // test re-affirms the contract explicitly by repeating the merge path
    // against a fresh adapter-populated store and asserting the same
    // end-state shape.
    await reprojectFromOnlineStore(ctx.store, {
      sources: { jsonExports: fixtureExportDir() },
      legacyProvenance: PROV,
      checkpointPath: path.join(ctx.tmpdir, 'reproject-checkpoint.json'),
    });

    // The store is now adapter-fronted (all entities have
    // legacyId.system === 'A' AND metadata.subsystem === 'online' —
    // see Test 1). resolveEntities runs against this graph through
    // exactly the same public API (findByOntologyClass + getDegree +
    // mergeEntities) it would use against a B-populated or C-populated
    // graph — SC#4.
    const observations = await ctx.store.findByOntologyClass('Observation');
    for (const e of observations) {
      // Adapter-fronted invariant — every observation came from A.
      expect(e.legacyId?.system).toBe('A');
    }

    const matcher = makeDeliberateDuplicateMatcher(DUP_OBS_A, DUP_OBS_B);
    const result = await resolveEntities(ctx.store, {
      llmMatcher: matcher,
      provenance: PROV,
      classes: ['Observation'],
      dryRun: false,
    });

    // Same end-state as Test 3 — merge applied against an adapter-fronted
    // graph indistinguishable from one a B/C migration would produce.
    expect(result.merges.length).toBe(1);
    const active = await ctx.store.findByOntologyClass('Observation');
    expect(active.length).toBe(observations.length - 1);
  });

  // ─────────────────────────────────────────────────────────────────
  // Test 5 — Idempotency: re-running reproject is a no-op
  // ─────────────────────────────────────────────────────────────────
  test('Idempotency — running reprojectFromOnlineStore twice yields the same active entity counts', async () => {
    const first = await reprojectFromOnlineStore(ctx.store, {
      sources: { jsonExports: fixtureExportDir() },
      legacyProvenance: PROV,
      checkpointPath: path.join(ctx.tmpdir, 'reproject-checkpoint.json'),
    });
    expect(first.written.observations).toBeGreaterThanOrEqual(1);

    const obsAfter1 = await ctx.store.findByOntologyClass('Observation');
    const digAfter1 = await ctx.store.findByOntologyClass('Digest');
    const insAfter1 = await ctx.store.findByOntologyClass('Insight');

    // Second run with the same data — written.* counters MUST be zero
    // because the legacyId resolver scan recognises every row.
    const second = await reprojectFromOnlineStore(ctx.store, {
      sources: { jsonExports: fixtureExportDir() },
      legacyProvenance: PROV,
      checkpointPath: path.join(ctx.tmpdir, 'reproject-checkpoint.json'),
    });
    expect(second.written.observations).toBe(0);
    expect(second.written.digests).toBe(0);
    expect(second.written.insights).toBe(0);

    const obsAfter2 = await ctx.store.findByOntologyClass('Observation');
    const digAfter2 = await ctx.store.findByOntologyClass('Digest');
    const insAfter2 = await ctx.store.findByOntologyClass('Insight');

    // Same active counts both times — entities aren't duplicated.
    expect(obsAfter2.length).toBe(obsAfter1.length);
    expect(digAfter2.length).toBe(digAfter1.length);
    expect(insAfter2.length).toBe(insAfter1.length);
  });

  // ─────────────────────────────────────────────────────────────────
  // Test 6 — DryRun resolveEntities returns plan without mutating store
  // ─────────────────────────────────────────────────────────────────
  test('SC#3 dryRun — resolveEntities(dryRun:true) returns the plan without invoking mergeEntities; active count unchanged', async () => {
    await reprojectFromOnlineStore(ctx.store, {
      sources: { jsonExports: fixtureExportDir() },
      legacyProvenance: PROV,
      checkpointPath: path.join(ctx.tmpdir, 'reproject-checkpoint.json'),
    });

    const beforeActive = (await ctx.store.findByOntologyClass('Observation'))
      .length;
    expect(beforeActive).toBeGreaterThanOrEqual(2);

    const matcher = makeDeliberateDuplicateMatcher(DUP_OBS_A, DUP_OBS_B);
    const result = await resolveEntities(ctx.store, {
      llmMatcher: matcher,
      provenance: PROV,
      classes: ['Observation'],
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.merges.length).toBeGreaterThanOrEqual(1);

    // Store is UNCHANGED — dryRun does not invoke mergeEntities.
    const afterActive = (await ctx.store.findByOntologyClass('Observation'))
      .length;
    expect(afterActive).toBe(beforeActive);
  });

  // ─────────────────────────────────────────────────────────────────
  // Test 7 — Aggregation edges materialised by reproject
  // ─────────────────────────────────────────────────────────────────
  test('SC#1 (graph edges) — reproject emits `aggregates` edges from Digest→Observation and Insight→Digest using the in-memory legacyId map', async () => {
    await reprojectFromOnlineStore(ctx.store, {
      sources: { jsonExports: fixtureExportDir() },
      legacyProvenance: PROV,
      checkpointPath: path.join(ctx.tmpdir, 'reproject-checkpoint.json'),
    });

    // The fixture cross-references Digest→Observation and Insight→Digest;
    // reproject emits one `aggregates` edge per cross-reference (Plan 04
    // SC#1 edge contract). We assert ≥1 here — the deliberate fixture has
    // 2 Digest→Observation refs (digest 1 references both deliberate
    // duplicates) plus 1 Digest→Observation (digest 2) plus 2 Insight→
    // Digest, but we only need ≥1 to satisfy the contract.
    const aggregates = await ctx.store.findRelations({ type: 'aggregates' });
    expect(aggregates.length).toBeGreaterThanOrEqual(1);

    // Verify the edges connect entities of the expected ontology classes —
    // Digest→Observation OR Insight→Digest, NEVER Observation→Digest.
    const observations = await ctx.store.findByOntologyClass('Observation');
    const digests = await ctx.store.findByOntologyClass('Digest');
    const insights = await ctx.store.findByOntologyClass('Insight');
    const obsIds = new Set(observations.map((e) => e.id));
    const digIds = new Set(digests.map((e) => e.id));
    const insIds = new Set(insights.map((e) => e.id));

    for (const rel of aggregates) {
      const fromIsDigest = digIds.has(rel.from);
      const fromIsInsight = insIds.has(rel.from);
      const toIsObservation = obsIds.has(rel.to);
      const toIsDigest = digIds.has(rel.to);
      // Either (Digest → Observation) OR (Insight → Digest).
      const validShape =
        (fromIsDigest && toIsObservation) ||
        (fromIsInsight && toIsDigest);
      expect(validShape).toBe(true);
    }
  });
});

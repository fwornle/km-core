// Phase 41 Plan 06 Task 2: comprehensive behavioral suite for resolveEntities.
//
// 11 tests (A–K) covering: happy path, dryRun, class filter, active-only
// default, error accumulation on LLM throw, mergeEntities failure caught,
// ontology default-class resolution via parentChainOf-by-.name (Plan 01
// live ontology dir), ontology-missing throw, getDegree survivor selection,
// unmatchable matchedTo (LLM hallucination), and deterministic tie-break
// on duplicate name+description.
//
// Test fixture conventions:
//   - `makeStoreCtx({ ontologyDir? })` builds a fresh tmpdir store; tests
//     that need the live LearningArtifact ontology pass the absolute path
//     to the package-root `ontology/` directory (Plan 01).
//   - `cleanup(ctx)` runs in `finally` per test (mirrors mergeEntities.test.ts
//     pattern).
//   - Mock LLMSemanticLayer is constructed inline per test using `vi.fn()`
//     so per-test return values are independent.
//
// Note on MatchResult shape: km-core's MatchResult has `survivor?: Entity`
// (NOT OKM's `matchedTo: { name, description }`). Mocks return the actual
// Entity instance from the candidate pool — resolveEntities does a defensive
// name+description reverse lookup to catch hallucinations and deterministic
// tie-break on collisions (Test J + K pin this contract).

import {
  describe,
  test,
  expect,
  vi,
  afterEach,
} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  GraphKMStore,
} from '../../../src/index.js';
import type {
  Entity,
  EntityId,
  ProvenanceStamp,
} from '../../../src/index.js';
import type {
  LLMSemanticLayer,
  MatchResult,
} from '../../../src/dedup/types.js';
import { resolveEntities } from '../../../src/maintenance/resolveEntities.js';

interface Ctx {
  store: GraphKMStore;
  tmpdir: string;
}

function makeStoreCtx(opts?: { ontologyDir?: string }): Ctx {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-resolve-'));
  const store = new GraphKMStore({
    dbPath: path.join(tmpdir, 'leveldb'),
    exportDir: path.join(tmpdir, 'exports'),
    debounceMs: 0,
    ontologyDir: opts?.ontologyDir,
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
  provider: 'resolveEntities-test',
  model: 'phase-41-plan-06',
  runId: 'test-run-static',
  timestamp: '2026-05-22T00:00:00.000Z',
};

/**
 * Seed an entity via the strict path (D-30 provenance required).
 * Returns the minted EntityId.
 *
 * Caller supplies `name`, `ontologyClass`, and an optional `description`
 * (default `'desc-' + name`) + optional `id` override + `validUntil` for
 * already-superseded seeds.
 */
async function seedEntity(
  store: GraphKMStore,
  args: {
    name: string;
    ontologyClass?: string;
    description?: string;
    id?: EntityId;
    validUntil?: string;
  },
): Promise<EntityId> {
  const ontologyClass = args.ontologyClass ?? 'Observation';
  const entity: Partial<Entity> = {
    name: args.name,
    entityType: ontologyClass,
    ontologyClass,
    layer: 'evidence',
    description: args.description ?? `desc-${args.name}`,
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
    metadata: {},
  };
  if (args.id !== undefined) entity.id = args.id;
  if (args.validUntil !== undefined) entity.validUntil = args.validUntil;
  return await store.putEntity(entity as Entity, {
    provenance: PROV,
    // Bypass ontology validation for tests that don't construct with the
    // live registry — the entity types (Observation/Digest/Insight) are
    // not registered against the test store's empty validator otherwise.
    skipOntologyCheck: true,
  });
}

/**
 * Build a mock LLMSemanticLayer with a `vi.fn()`-backed match() that
 * returns the same MatchResult per call. The `pairMap` argument lets
 * tests describe expected matches by (subjectName, candidateName) pairs
 * with the actual Entity instance pulled from the live candidate pool.
 */
function makeMockMatcher(
  matchFn: (
    entity: Entity,
    candidates: Entity[],
  ) => Promise<MatchResult>,
): LLMSemanticLayer & { match: ReturnType<typeof vi.fn> } {
  return {
    threshold: 0.7,
    match: vi.fn(matchFn),
  };
}

/**
 * Locate the live Plan 01 ontology dir (km-core/ontology/) — resolved
 * relative to this test file. Used by Test G (default-class resolution
 * coverage).
 */
function liveOntologyDir(): string {
  // tests/unit/maintenance/resolveEntities.test.ts → km-core/ontology/
  return path.resolve(import.meta.dirname, '..', '..', '..', 'ontology');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveEntities (Phase 41 Plan 06)', () => {
  // -------------------------------------------------------------------------
  // Test A: Happy path — 2 near-duplicate Observations + 2 unrelated → 1 merge
  // -------------------------------------------------------------------------
  test('A: happy path — surfaces 1 merge, supersedes duplicate, active-only post-merge', async () => {
    const ctx = makeStoreCtx();
    try {
      const o1 = await seedEntity(ctx.store, {
        name: 'OOM error',
        description: 'Out of memory thrown by JVM',
      });
      const o2 = await seedEntity(ctx.store, {
        name: 'Out of Memory',
        description: 'Heap exhausted on the Java process',
      });
      await seedEntity(ctx.store, {
        name: 'NullPointer',
        description: 'NPE in service layer',
      });
      await seedEntity(ctx.store, {
        name: 'DiskFull',
        description: 'Local SSD reached 100% capacity',
      });

      // Mock matches o1 against o2 (or vice versa, depending on iteration
      // order). The mock returns o2 as survivor when subject is o1, else
      // no-match.
      const matcher = makeMockMatcher(async (subject, candidates) => {
        if (subject.id === o1) {
          const c = candidates.find((c) => c.id === o2);
          if (c !== undefined) {
            return { matched: true, survivor: c, confidence: 0.95 };
          }
        }
        return { matched: false, confidence: 0 };
      });

      const result = await resolveEntities(ctx.store, {
        llmMatcher: matcher,
        provenance: PROV,
        classes: ['Observation'],
      });

      expect(result.merges.length).toBe(1);
      expect(result.merges[0].ontologyClass).toBe('Observation');
      expect(result.merges[0].confidence).toBe(0.95);
      expect(result.errors.length).toBe(0);
      expect(result.dryRun).toBe(false);
      expect(result.classesScanned).toEqual(['Observation']);

      // Post-merge: only 3 active Observations remain (one was superseded).
      const active = await ctx.store.findByOntologyClass('Observation');
      expect(active.length).toBe(3);
    } finally {
      await cleanup(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Test B: DryRun — plan computed, no mutation
  // -------------------------------------------------------------------------
  test('B: dryRun:true — plan computed, store unchanged', async () => {
    const ctx = makeStoreCtx();
    try {
      const o1 = await seedEntity(ctx.store, {
        name: 'OOM',
        description: 'memory',
      });
      const o2 = await seedEntity(ctx.store, {
        name: 'Out of Memory',
        description: 'memory',
      });
      await seedEntity(ctx.store, { name: 'OtherA' });
      await seedEntity(ctx.store, { name: 'OtherB' });

      const matcher = makeMockMatcher(async (subject, candidates) => {
        if (subject.id === o1) {
          const c = candidates.find((c) => c.id === o2);
          if (c !== undefined) {
            return { matched: true, survivor: c, confidence: 0.92 };
          }
        }
        return { matched: false, confidence: 0 };
      });

      const result = await resolveEntities(ctx.store, {
        llmMatcher: matcher,
        provenance: PROV,
        classes: ['Observation'],
        dryRun: true,
      });

      expect(result.merges.length).toBe(1);
      expect(result.dryRun).toBe(true);

      // No supersession occurred — all 4 still active.
      const active = await ctx.store.findByOntologyClass('Observation');
      expect(active.length).toBe(4);
    } finally {
      await cleanup(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Test C: Class filter — only specified class scanned
  // -------------------------------------------------------------------------
  test('C: classes filter — only Digest scanned; Observation pair left intact', async () => {
    const ctx = makeStoreCtx();
    try {
      // Seed duplicate pair in BOTH classes.
      const obs1 = await seedEntity(ctx.store, {
        name: 'ObsA',
        description: 'shared desc',
        ontologyClass: 'Observation',
      });
      const obs2 = await seedEntity(ctx.store, {
        name: 'ObsB',
        description: 'shared desc',
        ontologyClass: 'Observation',
      });
      await seedEntity(ctx.store, {
        name: 'ObsC',
        ontologyClass: 'Observation',
      });
      const dig1 = await seedEntity(ctx.store, {
        name: 'DigA',
        description: 'shared digest',
        ontologyClass: 'Digest',
      });
      const dig2 = await seedEntity(ctx.store, {
        name: 'DigB',
        description: 'shared digest',
        ontologyClass: 'Digest',
      });
      await seedEntity(ctx.store, {
        name: 'DigC',
        ontologyClass: 'Digest',
      });

      // Match both pairs unconditionally — but we'll filter to Digest only.
      const matcher = makeMockMatcher(async (subject, candidates) => {
        if (subject.id === obs1) {
          const c = candidates.find((c) => c.id === obs2);
          if (c !== undefined)
            return { matched: true, survivor: c, confidence: 0.9 };
        }
        if (subject.id === dig1) {
          const c = candidates.find((c) => c.id === dig2);
          if (c !== undefined)
            return { matched: true, survivor: c, confidence: 0.9 };
        }
        return { matched: false, confidence: 0 };
      });

      const result = await resolveEntities(ctx.store, {
        llmMatcher: matcher,
        provenance: PROV,
        classes: ['Digest'],
      });

      expect(result.classesScanned).toEqual(['Digest']);
      expect(result.merges.length).toBe(1);
      expect(result.merges[0].ontologyClass).toBe('Digest');

      // Observation pair untouched — still 3 active.
      const obsActive = await ctx.store.findByOntologyClass('Observation');
      expect(obsActive.length).toBe(3);
      // Digest pair merged — only 2 active.
      const digActive = await ctx.store.findByOntologyClass('Digest');
      expect(digActive.length).toBe(2);
    } finally {
      await cleanup(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Test D: Active-only — already-superseded entity not in candidate pool
  // -------------------------------------------------------------------------
  test('D: active-only — superseded entity not scanned (CF-D34)', async () => {
    const ctx = makeStoreCtx();
    try {
      await seedEntity(ctx.store, { name: 'ActiveA' });
      await seedEntity(ctx.store, { name: 'ActiveB' });
      // Seed a third, then close it via the trusted path to simulate
      // already-superseded state. Use a past validUntil so isActive() filter
      // excludes it.
      await seedEntity(ctx.store, {
        name: 'AlreadySuperseded',
        validUntil: '2020-01-01T00:00:00.000Z',
      });

      const seenSubjects: string[] = [];
      const matcher = makeMockMatcher(async (subject, _candidates) => {
        seenSubjects.push(subject.name);
        return { matched: false, confidence: 0 };
      });

      const result = await resolveEntities(ctx.store, {
        llmMatcher: matcher,
        provenance: PROV,
        classes: ['Observation'],
      });

      expect(result.merges.length).toBe(0);
      // The mock matcher should NEVER have seen the superseded entity.
      expect(seenSubjects).not.toContain('AlreadySuperseded');
    } finally {
      await cleanup(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Test E: Error accumulation — LLM throw on Nth call
  // -------------------------------------------------------------------------
  test('E: LLM throw caught into errors[]; scan continues', async () => {
    const ctx = makeStoreCtx();
    try {
      await seedEntity(ctx.store, { name: 'E1' });
      await seedEntity(ctx.store, { name: 'E2' });
      await seedEntity(ctx.store, { name: 'E3' });
      await seedEntity(ctx.store, { name: 'E4' });

      let calls = 0;
      const matcher = makeMockMatcher(async () => {
        calls += 1;
        if (calls === 3) throw new Error('mock LLM throws');
        return { matched: false, confidence: 0 };
      });

      const result = await resolveEntities(ctx.store, {
        llmMatcher: matcher,
        provenance: PROV,
        classes: ['Observation'],
      });

      // No throw bubbled. Errors[] populated.
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      expect(result.errors[0]).toContain('LLM resolution error');
    } finally {
      await cleanup(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Test F: mergeEntities failure caught (WR-02 violation)
  // -------------------------------------------------------------------------
  test('F: mergeEntities throw caught into errors[]; scan continues', async () => {
    const ctx = makeStoreCtx();
    try {
      const a = await seedEntity(ctx.store, { name: 'F-A', description: 'x' });
      const b = await seedEntity(ctx.store, { name: 'F-B', description: 'x' });
      // Pre-seed a SUPERSEDED_BY edge from `a` to a third entity to force
      // WR-02 violation when mergeEntities tries to add ANOTHER successor.
      const z = await seedEntity(ctx.store, { name: 'F-Z' });
      await ctx.store.addRelation({
        type: 'SUPERSEDED_BY',
        from: a,
        to: z,
        createdAt: '2026-05-22T01:00:00.000Z',
      });

      // Mock matches a vs b. Whichever ends up as duplicate, if it's `a`
      // mergeEntities throws on WR-02. Force matcher to pick `a` as the
      // duplicate by returning `b` as survivor (so when degree is equal,
      // subject wins — but we control via getDegree). Make `b` higher
      // degree to ensure `a` is the duplicate.
      const x = await seedEntity(ctx.store, { name: 'F-X' });
      const y = await seedEntity(ctx.store, { name: 'F-Y' });
      const w = await seedEntity(ctx.store, { name: 'F-W' });
      await ctx.store.addRelation({
        type: 'mentions',
        from: b,
        to: x,
        createdAt: '2026-05-22T01:01:00.000Z',
      });
      await ctx.store.addRelation({
        type: 'mentions',
        from: b,
        to: y,
        createdAt: '2026-05-22T01:02:00.000Z',
      });
      await ctx.store.addRelation({
        type: 'mentions',
        from: b,
        to: w,
        createdAt: '2026-05-22T01:03:00.000Z',
      });
      // b has degree 3; a has degree 1 (the SUPERSEDED_BY edge).

      const matcher = makeMockMatcher(async (subject, candidates) => {
        if (subject.id === a) {
          const c = candidates.find((c) => c.id === b);
          if (c !== undefined)
            return { matched: true, survivor: c, confidence: 0.9 };
        }
        return { matched: false, confidence: 0 };
      });

      const result = await resolveEntities(ctx.store, {
        llmMatcher: matcher,
        provenance: PROV,
        classes: ['Observation'],
      });

      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      expect(
        result.errors.some((e) => e.includes('mergeEntities failed')),
      ).toBe(true);
    } finally {
      await cleanup(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Test G: Ontology default-class resolution via parentChainOf-by-.name
  // -------------------------------------------------------------------------
  test('G: default classes resolved via parentChainOf (LearningArtifact subclasses)', async () => {
    const ctx = makeStoreCtx({ ontologyDir: liveOntologyDir() });
    try {
      // Seed near-duplicate pairs in BOTH Observation and Digest classes
      // (live Plan 01 ontology registers LearningArtifact + Observation +
      // Digest + Insight; we don't seed Insight entities so that class
      // is scanned but produces no merges).
      const obs1 = await seedEntity(ctx.store, {
        name: 'G-Obs1',
        description: 'shared',
        ontologyClass: 'Observation',
      });
      const obs2 = await seedEntity(ctx.store, {
        name: 'G-Obs2',
        description: 'shared',
        ontologyClass: 'Observation',
      });
      const dig1 = await seedEntity(ctx.store, {
        name: 'G-Dig1',
        description: 'shared',
        ontologyClass: 'Digest',
      });
      const dig2 = await seedEntity(ctx.store, {
        name: 'G-Dig2',
        description: 'shared',
        ontologyClass: 'Digest',
      });

      const matcher = makeMockMatcher(async (subject, candidates) => {
        if (subject.id === obs1) {
          const c = candidates.find((c) => c.id === obs2);
          if (c !== undefined)
            return { matched: true, survivor: c, confidence: 0.9 };
        }
        if (subject.id === dig1) {
          const c = candidates.find((c) => c.id === dig2);
          if (c !== undefined)
            return { matched: true, survivor: c, confidence: 0.9 };
        }
        return { matched: false, confidence: 0 };
      });

      // OMIT opts.classes — should default-resolve via the registry.
      const result = await resolveEntities(ctx.store, {
        llmMatcher: matcher,
        provenance: PROV,
      });

      // classesScanned must include at least Observation and Digest;
      // exact set depends on Plan 01's registered subclasses (Observation,
      // Digest, Insight all extend LearningArtifact per learning-artifacts.json).
      expect(result.classesScanned.sort()).toEqual(
        expect.arrayContaining(['Digest', 'Observation']),
      );
      // Both pairs surfaced and merged.
      expect(result.merges.length).toBe(2);
    } finally {
      await cleanup(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Test H: Ontology missing — throws when opts.classes omitted
  // -------------------------------------------------------------------------
  test('H: throws when opts.classes omitted and store has no ontology', async () => {
    const ctx = makeStoreCtx(); // no ontologyDir
    try {
      const matcher = makeMockMatcher(async () => ({
        matched: false,
        confidence: 0,
      }));

      await expect(
        resolveEntities(ctx.store, {
          llmMatcher: matcher,
          provenance: PROV,
        }),
      ).rejects.toThrow(
        /opts\.classes omitted but store has no ontology registry/,
      );
    } finally {
      await cleanup(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Test I: getDegree survivor selection — higher-degree node wins
  // -------------------------------------------------------------------------
  test('I: getDegree survivor selection — higher-degree node wins', async () => {
    const ctx = makeStoreCtx();
    try {
      const a = await seedEntity(ctx.store, {
        name: 'I-A',
        description: 'shared',
      });
      const b = await seedEntity(ctx.store, {
        name: 'I-B',
        description: 'shared',
      });
      // Boost A's degree to 5 (A→X1, A→X2, A→X3, A→X4, A→B).
      const x1 = await seedEntity(ctx.store, { name: 'I-X1' });
      const x2 = await seedEntity(ctx.store, { name: 'I-X2' });
      const x3 = await seedEntity(ctx.store, { name: 'I-X3' });
      const x4 = await seedEntity(ctx.store, { name: 'I-X4' });
      for (const [from, to, i] of [
        [a, x1, 0],
        [a, x2, 1],
        [a, x3, 2],
        [a, x4, 3],
        [a, b, 4],
      ] as Array<[EntityId, EntityId, number]>) {
        await ctx.store.addRelation({
          type: 'mentions',
          from,
          to,
          createdAt: `2026-05-22T01:0${String(i)}:00.000Z`,
        });
      }
      // B's degree = 2 (from A→B and from B→X1 added below).
      await ctx.store.addRelation({
        type: 'mentions',
        from: b,
        to: x1,
        createdAt: '2026-05-22T02:00:00.000Z',
      });

      // Sanity-check degrees pre-merge.
      expect(await ctx.store.getDegree(a)).toBe(5);
      expect(await ctx.store.getDegree(b)).toBe(2);

      const matcher = makeMockMatcher(async (subject, candidates) => {
        // Regardless of iteration order, surface the a↔b pair.
        if (subject.id === a) {
          const c = candidates.find((c) => c.id === b);
          if (c !== undefined)
            return { matched: true, survivor: c, confidence: 0.9 };
        }
        if (subject.id === b) {
          const c = candidates.find((c) => c.id === a);
          if (c !== undefined)
            return { matched: true, survivor: c, confidence: 0.9 };
        }
        return { matched: false, confidence: 0 };
      });

      const result = await resolveEntities(ctx.store, {
        llmMatcher: matcher,
        provenance: PROV,
        classes: ['Observation'],
      });

      expect(result.merges.length).toBe(1);
      // Survivor is A (higher degree).
      expect(result.merges[0].survivorId).toBe(a);
      expect(result.merges[0].duplicateId).toBe(b);
    } finally {
      await cleanup(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Test J: Unmatchable matchedTo — LLM survivor not in candidate pool
  // -------------------------------------------------------------------------
  test('J: unmatchable — LLM returns survivor not in candidate pool', async () => {
    const ctx = makeStoreCtx();
    try {
      await seedEntity(ctx.store, { name: 'J-A' });
      await seedEntity(ctx.store, { name: 'J-B' });
      await seedEntity(ctx.store, { name: 'J-C' });

      // Mock returns a hallucinated survivor — a never-seeded Entity object
      // whose name+description don't match any candidate.
      const ghost: Entity = {
        id: '00000000-0000-7000-8000-000000000000' as EntityId,
        name: 'GHOST',
        entityType: 'Observation',
        ontologyClass: 'Observation',
        layer: 'evidence',
        description: 'not-in-pool',
        createdAt: '2026-05-22T00:00:00.000Z',
        updatedAt: '2026-05-22T00:00:00.000Z',
        metadata: {},
      };
      const matcher = makeMockMatcher(async () => ({
        matched: true,
        survivor: ghost,
        confidence: 0.95,
      }));

      const result = await resolveEntities(ctx.store, {
        llmMatcher: matcher,
        provenance: PROV,
        classes: ['Observation'],
      });

      // No merges executed.
      expect(result.merges.length).toBe(0);
      // Errors[] populated with 'unmatchable' entries.
      expect(result.errors.length).toBeGreaterThanOrEqual(1);
      expect(result.errors.some((e) => e.includes('unmatchable'))).toBe(true);
    } finally {
      await cleanup(ctx);
    }
  });

  // -------------------------------------------------------------------------
  // Test K: Tie-break on duplicate name+description (deterministic lex-id)
  // -------------------------------------------------------------------------
  test('K: tie-break — duplicate name+description picks LOWEST lex-id', async () => {
    const ctx = makeStoreCtx();
    try {
      // Seed three entities. Entity1 and Entity2 share EXACTLY the same
      // name + description; Entity1.id is lex-smaller than Entity2.id.
      // Entity3 is the subject the matcher matches against.
      const sharedName = 'TieBreak-Name';
      const sharedDesc = 'TieBreak-Desc';
      const entity1Id = '00000000-0000-7000-8000-000000000001' as EntityId;
      const entity2Id = '00000000-0000-7000-8000-000000000002' as EntityId;
      await seedEntity(ctx.store, {
        name: sharedName,
        description: sharedDesc,
        id: entity1Id,
      });
      await seedEntity(ctx.store, {
        name: sharedName,
        description: sharedDesc,
        id: entity2Id,
      });
      const entity3Id = await seedEntity(ctx.store, {
        name: 'TieBreak-Subject',
        description: 'subject-only',
      });

      // Mock: when subject is Entity3, return a "survivor" whose name+
      // description matches BOTH Entity1 and Entity2. Pick Entity2 as the
      // returned survivor (the lex-LARGER id) — resolveEntities's
      // tie-break should override and pick Entity1 (lex-SMALLER) as the
      // duplicate row.
      const matcher = makeMockMatcher(async (subject, candidates) => {
        if (subject.id === entity3Id) {
          // Return Entity2 (lex-larger). Tie-break should resolve to Entity1.
          const e2 = candidates.find((c) => c.id === entity2Id);
          if (e2 !== undefined) {
            return { matched: true, survivor: e2, confidence: 0.95 };
          }
        }
        return { matched: false, confidence: 0 };
      });

      const result = await resolveEntities(ctx.store, {
        llmMatcher: matcher,
        provenance: PROV,
        classes: ['Observation'],
      });

      // Exactly one merge surfaced; duplicate is Entity1 (lex-smallest of
      // the two name+description-equal candidates).
      expect(result.merges.length).toBe(1);
      // Survivor/duplicate roles depend on degree (both have 0; tie →
      // subject wins). Subject is Entity3. So Entity3 (or its tie-break
      // counterpart Entity1) — but the duplicate side MUST be Entity1
      // (the tie-break-selected target).
      // Specifically: subject=Entity3, tie-break-target=Entity1, then
      // degree(Entity3)=0, degree(Entity1)=0 → subject wins as survivor →
      // survivor=Entity3, duplicate=Entity1.
      expect(result.merges[0].duplicateId).toBe(entity1Id);
    } finally {
      await cleanup(ctx);
    }
  });
});

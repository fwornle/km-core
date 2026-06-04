// CORE-02: GraphKMStore CRUD, batch, iterate, events, ontology validation.
//
// Wave 0 RED state: `GraphKMStore`, `mintEntityId`, `GraphKMStoreOptions` are
// not yet exported from '../../src/index.js'. Plan 04 (CORE-02 implementation)
// makes these GREEN. Test names must remain VERBATIM — Plans 04 and 05
// grep-verify them.

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  GraphKMStore,
  mintEntityId,
  type GraphKMStoreOptions,
  type ProvenanceStamp,
  type EntityProvenance,
  type EntityId,
} from '../../src/index.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface OntologyValidatorStub {
  validate: (entityType: string) => void;
}

// Phase 39 D-30: putEntity strict path requires opts.provenance. A single
// canonical stamp is reused across all Phase 37/38 tests below so each
// retains its prior intent (the test asserts CRUD/event/iterate semantics,
// not provenance); the Phase 39 tests at the END of the file construct
// their own provenance stamps per-test for D-32 create-vs-confirm logic.
const PROV: ProvenanceStamp = {
  provider: 'test',
  model: 'test-model',
  runId: 'baseline',
  timestamp: '2026-05-20T00:00:00.000Z',
};

type Ctx = {
  store: GraphKMStore;
  tmpdir: string;
};

function makeStore(extra?: Partial<GraphKMStoreOptions>): Ctx {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-test-'));
  const store = new GraphKMStore({
    dbPath: path.join(tmpdir, 'leveldb'),
    exportDir: path.join(tmpdir, 'exports'),
    debounceMs: 0,
    ...extra,
  });
  return { store, tmpdir };
}

describe('GraphKMStore', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = makeStore();
    await ctx.store.open();
  });

  afterEach(async () => {
    await ctx.store.close();
    fs.rmSync(ctx.tmpdir, { recursive: true, force: true });
  });

  test('putEntity then getEntity round-trip preserves all fields', async () => {
    const id = await ctx.store.putEntity(
      {
        name: 'Foo',
        entityType: 'Component',
        layer: 'evidence',
        description: 'A test component',
        createdAt: '2026-05-19T00:00:00Z',
        updatedAt: '2026-05-19T00:00:00Z',
        metadata: { domain: 'general' },
      },
      { provenance: PROV },
    );
    const got = await ctx.store.getEntity(id);
    expect(got).toBeDefined();
    expect(got!.id).toBe(id);
    expect(got!.name).toBe('Foo');
    expect(got!.entityType).toBe('Component');
    expect(got!.layer).toBe('evidence');
    expect(got!.description).toBe('A test component');
    // Phase 39: putEntity now folds EntityProvenance into metadata under
    // metadata.provenance. The original `domain: 'general'` survives the
    // spread, alongside the auto-stamped provenance struct.
    expect(got!.metadata.domain).toBe('general');
    expect(got!.metadata.provenance).toBeDefined();
  });

  test('putEntity with caller-supplied valid UUIDv7 keeps id verbatim', async () => {
    const supplied = mintEntityId();
    const id = await ctx.store.putEntity(
      {
        id: supplied,
        name: 'Bar',
        entityType: 'Component',
      },
      { provenance: PROV },
    );
    expect(id).toBe(supplied);
    const got = await ctx.store.getEntity(supplied);
    expect(got!.id).toBe(supplied);
  });

  test('putEntity with caller-supplied invalid id throws SyntaxError', async () => {
    await expect(
      ctx.store.putEntity(
        {
          id: 'not-a-uuid' as unknown as ReturnType<typeof mintEntityId>,
          name: 'Bad',
          entityType: 'Component',
        },
        { provenance: PROV },
      ),
    ).rejects.toThrow(SyntaxError);
  });

  test('putEntity emits entity:put event with the stored entity', async () => {
    const handler = vi.fn();
    ctx.store.on('entity:put', handler);
    const id = await ctx.store.putEntity(
      {
        name: 'Evt',
        entityType: 'Component',
      },
      { provenance: PROV },
    );
    expect(handler).toHaveBeenCalledTimes(1);
    const payload = handler.mock.calls[0]![0] as { entity: { id: string } };
    expect(payload.entity.id).toBe(id);
  });

  test('deleteEntity removes node and emits entity:delete', async () => {
    const id = await ctx.store.putEntity(
      {
        name: 'ToDelete',
        entityType: 'Component',
      },
      { provenance: PROV },
    );
    const handler = vi.fn();
    ctx.store.on('entity:delete', handler);
    await ctx.store.deleteEntity(id);
    expect(await ctx.store.getEntity(id)).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('addRelation persists edge and emits relation:added', async () => {
    const a = await ctx.store.putEntity(
      { name: 'A', entityType: 'Component' },
      { provenance: PROV },
    );
    const b = await ctx.store.putEntity(
      { name: 'B', entityType: 'Component' },
      { provenance: PROV },
    );
    const handler = vi.fn();
    ctx.store.on('relation:added', handler);
    await ctx.store.addRelation({ type: 'CONTAINS', from: a, to: b });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('findByOntologyClass returns only entities matching the class', async () => {
    await ctx.store.putEntity(
      {
        name: 'P',
        entityType: 'Project',
        ontologyClass: 'Project',
      },
      { provenance: PROV },
    );
    await ctx.store.putEntity(
      {
        name: 'C',
        entityType: 'Component',
        ontologyClass: 'Component',
      },
      { provenance: PROV },
    );
    const projects = await ctx.store.findByOntologyClass('Project');
    expect(projects.length).toBe(1);
    expect(projects[0]!.name).toBe('P');
  });

  test('batch is all-or-nothing on validation failure', async () => {
    const handler = vi.fn();
    ctx.store.on('entity:put', handler);
    await expect(
      ctx.store.batch([
        { type: 'putEntity', entity: { name: 'X', entityType: 'Component' } },
        {
          type: 'putEntity',
          entity: {
            id: 'not-a-uuid' as unknown as ReturnType<typeof mintEntityId>,
            name: 'Y',
            entityType: 'Component',
          },
        },
        { type: 'putEntity', entity: { name: 'Z', entityType: 'Component' } },
      ]),
    ).rejects.toThrow();
    // State unchanged AND no events fired.
    expect(handler).not.toHaveBeenCalled();
    let count = 0;
    for await (const _ of ctx.store.iterate()) count++;
    expect(count).toBe(0);
  });

  test('iterate yields entities lazily and respects filter', async () => {
    await ctx.store.putEntity(
      { name: 'A', entityType: 'Component' },
      { provenance: PROV },
    );
    await ctx.store.putEntity(
      { name: 'B', entityType: 'Pattern' },
      { provenance: PROV },
    );
    await ctx.store.putEntity(
      { name: 'C', entityType: 'Component' },
      { provenance: PROV },
    );
    const components: string[] = [];
    for await (const e of ctx.store.iterate({ entityType: 'Component' })) {
      components.push(e.name);
    }
    expect(components.sort()).toEqual(['A', 'C']);
  });

  test('strict ontology validation rejects unknown class', async () => {
    await ctx.store.close();
    fs.rmSync(ctx.tmpdir, { recursive: true, force: true });
    const validator: OntologyValidatorStub = {
      validate: (cls) => {
        if (!['Project', 'Component'].includes(cls)) {
          throw new Error(`Unknown ontology class: ${cls}`);
        }
      },
    };
    ctx = makeStore({ ontologyValidator: validator });
    await ctx.store.open();
    // Note: ontology validator runs BEFORE the D-30 provenance check, so
    // an unknown-class throw happens regardless of whether provenance is
    // supplied. We pass PROV for symmetry with the rest of the suite.
    await expect(
      ctx.store.putEntity(
        { name: 'Bogus', entityType: 'Bogus' },
        { provenance: PROV },
      ),
    ).rejects.toThrow(/Unknown ontology class/);
  });

  test('skipOntologyCheck flag bypasses validation', async () => {
    await ctx.store.close();
    fs.rmSync(ctx.tmpdir, { recursive: true, force: true });
    const validator: OntologyValidatorStub = {
      validate: (cls) => {
        throw new Error(`Reject ${cls}`);
      },
    };
    ctx = makeStore({ ontologyValidator: validator });
    await ctx.store.open();
    const id = await ctx.store.putEntity(
      { name: 'Bypass', entityType: 'AnythingGoes' },
      { skipOntologyCheck: true },
    );
    expect(id).toBeDefined();
  });

  // Phase 38 Plan 06 Task 2 — APPENDED tests (do NOT modify the 11 above).
  // New Test 1 verifies Plan 38-05's auto-wired registry-backed validator.
  // New Test 2 verifies Phase 37 BC-2 (skipOntologyCheck widening) survives Plan 05.

  test('ontologyDir option auto-wires registry-backed validator', async () => {
    await ctx.store.close();
    fs.rmSync(ctx.tmpdir, { recursive: true, force: true });

    ctx = makeStore({
      ontologyDir: path.join(import.meta.dirname, '../fixtures/ontology'),
    });
    await ctx.store.open();

    // Registry is exposed via the Plan 38-05 getter (D-28).
    expect(ctx.store.ontology).toBeDefined();
    expect(ctx.store.ontology!.isValidClass('Component')).toBe(true); // upper.json
    expect(ctx.store.ontology!.isValidClass('RPU')).toBe(true);       // raas.json
    expect(ctx.store.ontology!.isValidClass('Bogus')).toBe(false);

    // Valid class succeeds.
    const id = await ctx.store.putEntity(
      { name: 'Valid', entityType: 'Component' },
      { provenance: PROV },
    );
    expect(id).toBeDefined();

    // Invalid class is rejected with the Phase 37 verbatim error-text regex
    // (Plan 38-04 contract: `Unknown ontology class: ${entityType}`).
    await expect(
      ctx.store.putEntity(
        { name: 'Bogus', entityType: 'Bogus' },
        { provenance: PROV },
      ),
    ).rejects.toThrow(/Unknown ontology class/);
  });

  test('skipOntologyCheck bypasses registry validator (CF-D19 / BC-2)', async () => {
    await ctx.store.close();
    fs.rmSync(ctx.tmpdir, { recursive: true, force: true });
    ctx = makeStore({
      ontologyDir: path.join(import.meta.dirname, '../fixtures/ontology'),
    });
    await ctx.store.open();

    // skipOntologyCheck: true MUST bypass BOTH parseEntityId AND the registry-
    // backed validator (Phase 37 BC-2 widening preserved by Plan 05). Pass a
    // non-v7 id and a class not in the registry; both gates are skipped.
    const id = await ctx.store.putEntity(
      {
        id: 'not-a-uuid' as unknown as ReturnType<typeof mintEntityId>,
        name: 'TrustedBulk',
        entityType: 'NotInRegistry',
      },
      { skipOntologyCheck: true },
    );
    expect(id).toBe('not-a-uuid');
  });
});

// Phase 39 Plan 01 Task 2 — APPENDED tests for D-30/D-31/D-32 writer-side
// stamping. DO NOT modify the 13 GraphKMStore tests above. These five tests
// stand in their own describe block so the test count is grep-verifiable
// (must_haves: 5+ new tests appended; 33 baseline preserved).
describe('Phase 39 — writer-side stamping (D-30/D-31/D-32)', () => {
  let ctx: Ctx;

  // Per-test provenance factory: each test constructs its own stamp with a
  // suffix-bearing runId so D-32 create-vs-confirm assertions can distinguish
  // first-write provenance from subsequent confirmations.
  function mkProvenance(suffix: string): ProvenanceStamp {
    return {
      provider: 'test',
      model: 'test-model',
      runId: `run-${suffix}`,
      timestamp: new Date().toISOString(),
    };
  }

  beforeEach(async () => {
    ctx = makeStore();
    await ctx.store.open();
  });

  afterEach(async () => {
    await ctx.store.close();
    fs.rmSync(ctx.tmpdir, { recursive: true, force: true });
  });

  test('putEntity auto-stamps validFrom when caller omits it (D-31)', async () => {
    const beforeMs = Date.now();
    const id = await ctx.store.putEntity(
      { name: 'AutoStamp', entityType: 'Component' },
      { provenance: mkProvenance('1') },
    );
    const got = await ctx.store.getEntity(id);
    expect(got).toBeDefined();
    expect(got!.validFrom).toBeDefined();
    const validFromMs = new Date(got!.validFrom!).getTime();
    // Within 5 seconds of "now" — generous bound to avoid flaky CI clocks.
    expect(validFromMs).toBeGreaterThanOrEqual(beforeMs);
    expect(validFromMs).toBeLessThanOrEqual(beforeMs + 5000);
  });

  test('putEntity sets EntityProvenance from provenance opt on first write (D-30, D-32)', async () => {
    const stamp = mkProvenance('1');
    const id = await ctx.store.putEntity(
      { name: 'FirstWrite', entityType: 'Component' },
      { provenance: stamp },
    );
    const got = await ctx.store.getEntity(id);
    const prov = got!.metadata.provenance as EntityProvenance | undefined;
    expect(prov).toBeDefined();
    expect(prov!.createdBy.runId).toBe('run-1');
    expect(prov!.lastConfirmedBy.runId).toBe('run-1');
    expect(prov!.confirmationCount).toBe(1);
    // Full stamp shape preserved (provider/model/timestamp threaded through).
    expect(prov!.createdBy.provider).toBe('test');
    expect(prov!.createdBy.model).toBe('test-model');
    expect(prov!.createdBy.timestamp).toBe(stamp.timestamp);
  });

  test('putEntity on existing id increments confirmationCount and preserves createdBy (D-32)', async () => {
    const supplied = mintEntityId();
    // First write with run-1.
    await ctx.store.putEntity(
      { id: supplied, name: 'Confirmed', entityType: 'Component' },
      { provenance: mkProvenance('1') },
    );
    // Second write with run-2 against the SAME id — should preserve createdBy
    // from the first write, update lastConfirmedBy, and bump confirmationCount.
    await ctx.store.putEntity(
      { id: supplied, name: 'Confirmed', entityType: 'Component' },
      { provenance: mkProvenance('2') },
    );
    const got = await ctx.store.getEntity(supplied);
    const prov = got!.metadata.provenance as EntityProvenance | undefined;
    expect(prov).toBeDefined();
    expect(prov!.createdBy.runId).toBe('run-1'); // preserved from first write
    expect(prov!.lastConfirmedBy.runId).toBe('run-2'); // overwritten
    expect(prov!.confirmationCount).toBe(2);
  });

  test('putEntity throws when provenance missing on strict path (D-30)', async () => {
    // Empty opts — provenance missing.
    await expect(
      ctx.store.putEntity({ name: 'X', entityType: 'Component' }, {}),
    ).rejects.toThrow(/requires opts\.provenance/);
    // No opts at all — provenance missing.
    await expect(
      ctx.store.putEntity({ name: 'X', entityType: 'Component' }),
    ).rejects.toThrow(/requires opts\.provenance/);
  });

  test('putEntity with skipOntologyCheck:true bypasses provenance requirement (BC-2)', async () => {
    // Trusted-caller path bypasses BOTH ontology validation AND the D-30
    // provenance requirement. Backfill / fixture replay can pass an
    // entity without supplying opts.provenance; the store does not assemble
    // EntityProvenance on the trusted path (caller stamps it themselves).
    const id = await ctx.store.putEntity(
      {
        id: 'legacy-nanoid-key' as unknown as ReturnType<typeof mintEntityId>,
        name: 'LegacyBulk',
        entityType: 'NotInRegistry',
      },
      { skipOntologyCheck: true },
    );
    expect(id).toBe('legacy-nanoid-key');
    const got = await ctx.store.getEntity(id);
    expect(got).toBeDefined();
    expect(got!.name).toBe('LegacyBulk');
    // Trusted path does NOT auto-stamp metadata.provenance — caller's
    // responsibility (Phase 39 backfill pre-stamps before invoking this path).
    expect(got!.metadata?.provenance).toBeUndefined();
  });
});

// Phase 39 Plan 03 Task 2 — APPENDED tests for D-33 supersession closure,
// D-34 active-only filter (default + opt-in), D-35 getSupersessionChain.
// Sibling describe block — do NOT modify the 5 Plan-01 tests above. Plan 03
// must add 11 tests total: 10 for the new D-33/D-34/D-35 behaviors plus the
// Pitfall 1 regression guard for the validUntil === undefined short-circuit.
describe('Phase 39 — supersession + active-only filter (D-33/D-34/D-35)', () => {
  let ctx: Ctx;

  // Per-test provenance factory: suffix-bearing runId distinguishes the
  // pre/post writes when asserting confirmationCount / supersession order.
  function mkProvenance(suffix: string): ProvenanceStamp {
    return {
      provider: 'test',
      model: 'test-model',
      runId: `run-${suffix}`,
      timestamp: new Date().toISOString(),
    };
  }

  beforeEach(async () => {
    ctx = makeStore();
    await ctx.store.open();
  });

  afterEach(async () => {
    await ctx.store.close();
    fs.rmSync(ctx.tmpdir, { recursive: true, force: true });
  });

  test('putEntity with supersedes closes predecessor validUntil atomically (D-33)', async () => {
    const aId = await ctx.store.putEntity(
      { name: 'A', entityType: 'Component' },
      { provenance: mkProvenance('A') },
    );
    const bId = await ctx.store.putEntity(
      { name: 'B', entityType: 'Component', supersedes: aId },
      { provenance: mkProvenance('B') },
    );
    const a = await ctx.store.getEntity(aId);
    const b = await ctx.store.getEntity(bId);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.validUntil).toBeDefined();
    expect(a!.validUntil).toBe(b!.validFrom);
  });

  test('putEntity with supersedes adds a SUPERSEDED_BY relation (D-33 reverse-edge)', async () => {
    const aId = await ctx.store.putEntity(
      { name: 'A', entityType: 'Component' },
      { provenance: mkProvenance('A') },
    );
    const bId = await ctx.store.putEntity(
      { name: 'B', entityType: 'Component', supersedes: aId },
      { provenance: mkProvenance('B') },
    );
    const rels = await ctx.store.findRelations({ type: 'SUPERSEDED_BY' });
    expect(rels.length).toBe(1);
    expect(rels[0]!.from).toBe(aId);
    expect(rels[0]!.to).toBe(bId);
  });

  test('putEntity with supersedes emits entity:put for BOTH old and new (D-33 batch atomicity)', async () => {
    const aId = await ctx.store.putEntity(
      { name: 'A', entityType: 'Component' },
      { provenance: mkProvenance('A') },
    );
    // Spy AFTER A is created so we only see the supersession-batch events.
    const handler = vi.fn();
    ctx.store.on('entity:put', handler);
    await ctx.store.putEntity(
      { name: 'B', entityType: 'Component', supersedes: aId },
      { provenance: mkProvenance('B') },
    );
    // batch([put closedOld, put newEntity]) fires entity:put twice.
    expect(handler.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test('putEntity with supersedes warns when predecessor validUntil already set (D-33 stderr-warn)', async () => {
    const aId = await ctx.store.putEntity(
      { name: 'A', entityType: 'Component' },
      { provenance: mkProvenance('A') },
    );
    // Manually pre-stamp validUntil on A via mergeAttributes (T-37-04-06
    // accepted; mergeAttributes does NOT re-run ontology / provenance).
    await ctx.store.mergeAttributes(aId, {
      validUntil: '2026-04-01T00:00:00.000Z',
    });
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      await ctx.store.putEntity(
        { name: 'B', entityType: 'Component', supersedes: aId },
        { provenance: mkProvenance('B') },
      );
      const writes = stderrSpy.mock.calls.map((c) => String(c[0]));
      expect(
        writes.some((w) => /overwriting validUntil/.test(w)),
      ).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  test('putEntity confirm-write with supersedes set is a silent no-op on supersession branch (D-33 + OQ#4 resolution)', async () => {
    // Create A and B independently (no supersedes between them).
    const aId = await ctx.store.putEntity(
      { name: 'A', entityType: 'Component' },
      { provenance: mkProvenance('A') },
    );
    const bId = await ctx.store.putEntity(
      { name: 'B', entityType: 'Component' },
      { provenance: mkProvenance('B') },
    );
    // Confirm-write A with supersedes: bId set. Per OQ#4: predecessor
    // closure + SUPERSEDED_BY fire ONLY on the create branch (guarded by
    // `!existing`). The confirm-write itself (lastConfirmedBy /
    // confirmationCount) still happens.
    await ctx.store.putEntity(
      { id: aId, name: 'A', entityType: 'Component', supersedes: bId },
      { provenance: mkProvenance('A2') },
    );
    // (1) A's validUntil is NOT closed by its own re-write.
    const a = await ctx.store.getEntity(aId);
    expect(a!.validUntil).toBeUndefined();
    // (2) B is untouched — no backward closure fired against B.
    const b = await ctx.store.getEntity(bId);
    expect(b!.validUntil).toBeUndefined();
    // (3) No SUPERSEDED_BY edge in either direction.
    const rels = await ctx.store.findRelations({ type: 'SUPERSEDED_BY' });
    expect(rels.length).toBe(0);
    // (4) The confirm-write itself succeeded: lastConfirmedBy = run-A2.
    const prov = a!.metadata.provenance as EntityProvenance | undefined;
    expect(prov).toBeDefined();
    expect(prov!.lastConfirmedBy.runId).toBe('run-A2');
    // (5) confirmationCount incremented to 2 (first-write was run-A).
    expect(prov!.confirmationCount).toBe(2);
  });

  test('findByOntologyClass excludes superseded entities by default (D-34)', async () => {
    const aId = await ctx.store.putEntity(
      { name: 'A', entityType: 'Component' },
      { provenance: mkProvenance('A') },
    );
    await ctx.store.putEntity(
      { name: 'B', entityType: 'Component', supersedes: aId },
      { provenance: mkProvenance('B') },
    );
    const found = await ctx.store.findByOntologyClass('Component');
    const names = found.map((e) => e.name);
    expect(names).toContain('B');
    expect(names).not.toContain('A');
  });

  test('findByOntologyClass with includeSuperseded:true returns history (D-34 opt-in)', async () => {
    const aId = await ctx.store.putEntity(
      { name: 'A', entityType: 'Component' },
      { provenance: mkProvenance('A') },
    );
    await ctx.store.putEntity(
      { name: 'B', entityType: 'Component', supersedes: aId },
      { provenance: mkProvenance('B') },
    );
    const found = await ctx.store.findByOntologyClass('Component', {
      includeSuperseded: true,
    });
    const names = found.map((e) => e.name).sort();
    expect(names).toEqual(['A', 'B']);
  });

  test('iterate excludes superseded entities by default (D-34)', async () => {
    const aId = await ctx.store.putEntity(
      { name: 'A', entityType: 'Component' },
      { provenance: mkProvenance('A') },
    );
    await ctx.store.putEntity(
      { name: 'B', entityType: 'Component', supersedes: aId },
      { provenance: mkProvenance('B') },
    );
    const yielded: string[] = [];
    for await (const e of ctx.store.iterate()) yielded.push(e.name);
    expect(yielded).toEqual(['B']);
  });

  test('iterate with includeSuperseded:true returns history (D-34 opt-in)', async () => {
    const aId = await ctx.store.putEntity(
      { name: 'A', entityType: 'Component' },
      { provenance: mkProvenance('A') },
    );
    await ctx.store.putEntity(
      { name: 'B', entityType: 'Component', supersedes: aId },
      { provenance: mkProvenance('B') },
    );
    const yielded: string[] = [];
    for await (const e of ctx.store.iterate(undefined, {
      includeSuperseded: true,
    })) {
      yielded.push(e.name);
    }
    expect(yielded.sort()).toEqual(['A', 'B']);
  });

  test('getSupersessionChain returns ordered chain from origin through tip (D-35)', async () => {
    const aId = await ctx.store.putEntity(
      { name: 'A', entityType: 'Component' },
      { provenance: mkProvenance('A') },
    );
    const bId = await ctx.store.putEntity(
      { name: 'B', entityType: 'Component', supersedes: aId },
      { provenance: mkProvenance('B') },
    );
    const cId = await ctx.store.putEntity(
      { name: 'C', entityType: 'Component', supersedes: bId },
      { provenance: mkProvenance('C') },
    );
    // Walking from the MIDDLE of the chain should still return all three,
    // ordered by validFrom ascending: [A, B, C].
    const chain = await ctx.store.getSupersessionChain(bId);
    expect(chain.length).toBe(3);
    expect(chain.map((e) => e.id)).toEqual([aId, bId, cId]);
    expect(chain.map((e) => e.name)).toEqual(['A', 'B', 'C']);
    // validFrom ascending: A.validFrom <= B.validFrom <= C.validFrom.
    expect(new Date(chain[0]!.validFrom!).getTime()).toBeLessThanOrEqual(
      new Date(chain[1]!.validFrom!).getTime(),
    );
    expect(new Date(chain[1]!.validFrom!).getTime()).toBeLessThanOrEqual(
      new Date(chain[2]!.validFrom!).getTime(),
    );
  });

  test('getSupersessionChain on entity not in graph returns empty array (D-35)', async () => {
    const result = await ctx.store.getSupersessionChain(
      'nonexistent-uuid' as unknown as EntityId,
    );
    expect(result.length).toBe(0);
  });

  test('findByOntologyClass returns entities without validUntil (Phase 37/38 BC preserved)', async () => {
    // Pitfall 1 regression guard: entities with validUntil === undefined
    // MUST pass the active-only filter unconditionally. This is the
    // short-circuit that keeps the Phase 37/38 `findByOntologyClass
    // returns only entities matching the class` test green.
    await ctx.store.putEntity(
      { name: 'NoValidUntil', entityType: 'Component' },
      { provenance: mkProvenance('NV') },
    );
    const found = await ctx.store.findByOntologyClass('Component');
    expect(found.length).toBe(1);
    expect(found[0]!.name).toBe('NoValidUntil');
    expect(found[0]!.validUntil).toBeUndefined();
  });

  test('putEntity supersession closes a legacy-id predecessor atomically (CR-01 regression)', async () => {
    // CR-01 regression guard: the supersession closure's batch() call must
    // bypass parseEntityId for the predecessor when the predecessor was
    // originally stored via the trusted path with a non-v7 id (legacy
    // nanoid, layer-prefixed, etc.). Without the per-op skipOntologyCheck
    // flag on the closedOld batch op, Phase 1 validation throws and D-33
    // atomicity breaks for the cross-epoch case.
    //
    // Seed a legacy-id predecessor via the trusted path (nanoid-style id,
    // pre-stamped metadata.provenance + validFrom so the supersession
    // closure has a valid `entity.validFrom!` source to close against).
    const legacyOldId = 'legacy-nanoid-abc-def' as EntityId;
    const legacyProv: EntityProvenance = {
      createdBy: mkProvenance('legacy'),
      lastConfirmedBy: mkProvenance('legacy'),
      confirmationCount: 1,
    };
    await ctx.store.putEntity(
      {
        id: legacyOldId,
        name: 'LegacyOld',
        entityType: 'Component',
        layer: 'evidence',
        description: '',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        validFrom: '2025-01-01T00:00:00.000Z',
        metadata: { provenance: legacyProv },
      },
      { skipOntologyCheck: true },
    );
    // Now supersede the legacy entity with a fresh v7-id entity via the
    // STRICT path — this triggers the D-33 closure, which is what CR-01
    // broke. The closure's batch() must succeed end-to-end.
    const newId = await ctx.store.putEntity(
      {
        name: 'NewV7',
        entityType: 'Component',
        supersedes: legacyOldId,
      },
      { provenance: mkProvenance('NewV7') },
    );
    // Assert both writes landed atomically:
    //   (1) predecessor's validUntil = new entity's validFrom.
    const oldAfter = await ctx.store.getEntity(legacyOldId);
    const newAfter = await ctx.store.getEntity(newId);
    expect(oldAfter).toBeDefined();
    expect(newAfter).toBeDefined();
    expect(oldAfter!.validUntil).toBeDefined();
    expect(oldAfter!.validUntil).toBe(newAfter!.validFrom);
    //   (2) SUPERSEDED_BY edge materialized for D-35 reverse-walk.
    const rels = await ctx.store.findRelations({ type: 'SUPERSEDED_BY' });
    expect(rels.length).toBe(1);
    expect(rels[0]!.from).toBe(legacyOldId);
    expect(rels[0]!.to).toBe(newId);
  });
});

// Phase 41 Plan 03 — APPENDED tests for `getDegree(id)` public method.
// Sibling describe block — do NOT modify the existing blocks above. Tests pin
// literal degree values per the deterministic semantics of
// graphology@^0.26's `MultiDirectedGraph.degree(node)`:
//   - degree(node) is the sum of inDegree + outDegree for `node`.
//   - For a single directed edge A→B: degree(A) === 1 and degree(B) === 1
//     (A contributes 1 outgoing, B contributes 1 incoming).
//   - For 3 outgoing edges A→B, A→C, A→D: degree(A) === 3.
//   - Missing nodes return 0 (caller-friendly contract; never throws).
// These values are the contract Plan 06 (`resolveEntities`) relies on for
// OKM-pattern survivor-selection.
describe('getDegree (Phase 41 Plan 03)', () => {
  let ctx: Ctx;

  function mkProvenance(suffix: string): ProvenanceStamp {
    return {
      provider: 'test',
      model: 'test-model',
      runId: `run-${suffix}`,
      timestamp: new Date().toISOString(),
    };
  }

  beforeEach(async () => {
    ctx = makeStore();
    await ctx.store.open();
  });

  afterEach(async () => {
    await ctx.store.close();
    fs.rmSync(ctx.tmpdir, { recursive: true, force: true });
  });

  test('Test A: single directed edge A→B gives both endpoints degree === 1', async () => {
    const aId = await ctx.store.putEntity(
      { name: 'A', entityType: 'Component' },
      { provenance: mkProvenance('A') },
    );
    const bId = await ctx.store.putEntity(
      { name: 'B', entityType: 'Component' },
      { provenance: mkProvenance('B') },
    );
    await ctx.store.addRelation({ type: 'CONTAINS', from: aId, to: bId });
    expect(await ctx.store.getDegree(aId)).toBe(1);
    expect(await ctx.store.getDegree(bId)).toBe(1);
  });

  test('Test B: 3 outgoing edges from A yield degree(A) === 3', async () => {
    const aId = await ctx.store.putEntity(
      { name: 'A', entityType: 'Component' },
      { provenance: mkProvenance('A') },
    );
    const bId = await ctx.store.putEntity(
      { name: 'B', entityType: 'Component' },
      { provenance: mkProvenance('B') },
    );
    const cId = await ctx.store.putEntity(
      { name: 'C', entityType: 'Component' },
      { provenance: mkProvenance('C') },
    );
    const dId = await ctx.store.putEntity(
      { name: 'D', entityType: 'Component' },
      { provenance: mkProvenance('D') },
    );
    await ctx.store.addRelation({ type: 'CONTAINS', from: aId, to: bId });
    await ctx.store.addRelation({ type: 'CONTAINS', from: aId, to: cId });
    await ctx.store.addRelation({ type: 'CONTAINS', from: aId, to: dId });
    expect(await ctx.store.getDegree(aId)).toBe(3);
  });

  test('Test C: getDegree on nonexistent id returns 0 and does not throw', async () => {
    const missing = 'nonexistent-id' as unknown as EntityId;
    // Must not throw, AND must return exactly 0 (caller-friendly contract;
    // Plan 06 relies on `0` rather than an exception when one or both of a
    // pair has been deleted by a concurrent merge).
    await expect(ctx.store.getDegree(missing)).resolves.toBe(0);
  });
});

// Phase 44 Plan 14 — APPENDED tests for `countByOntologyClass`,
// `lastModifiedByClass`, and `findByLegacyId`. The three helpers back
// `GET /api/consolidation/status` (top-line COUNTs + staleness clock) and
// `POST /api/insights/:id/resynthesize` (legacyId lookup) in obs-api after
// the legacy-endpoint cutover. Sibling describe block — do NOT modify the
// existing blocks above.
describe('countByOntologyClass / lastModifiedByClass / findByLegacyId (Phase 44 Plan 14)', () => {
  let ctx: Ctx;

  function mkProvenance(suffix: string): ProvenanceStamp {
    return {
      provider: 'test',
      model: 'test-model',
      runId: `run-${suffix}`,
      timestamp: new Date().toISOString(),
    };
  }

  beforeEach(async () => {
    ctx = makeStore();
    await ctx.store.open();
  });

  afterEach(async () => {
    await ctx.store.close();
    fs.rmSync(ctx.tmpdir, { recursive: true, force: true });
  });

  test('countByOntologyClass returns 0 for an empty class without throwing', async () => {
    // T-44-14-01 mitigation: dashboard COUNTs must NOT throw on an empty
    // store. Pre-Plan-14 the SQLite-backed handler returned 0 implicitly
    // via `SELECT COUNT(*) ... FROM observations` returning {cnt: 0}; the
    // km-core replacement must preserve that contract.
    const obs = await ctx.store.countByOntologyClass('Observation');
    const dig = await ctx.store.countByOntologyClass('Digest');
    const ins = await ctx.store.countByOntologyClass('Insight');
    expect(obs).toBe(0);
    expect(dig).toBe(0);
    expect(ins).toBe(0);
  });

  test('countByOntologyClass counts only entities matching the class', async () => {
    // Seed 3 Observation + 2 Digest + 1 Insight + 1 Component (decoy).
    for (const n of ['o1', 'o2', 'o3']) {
      await ctx.store.putEntity(
        { name: n, entityType: 'Observation', ontologyClass: 'Observation' },
        { provenance: mkProvenance(n) },
      );
    }
    for (const n of ['d1', 'd2']) {
      await ctx.store.putEntity(
        { name: n, entityType: 'Digest', ontologyClass: 'Digest' },
        { provenance: mkProvenance(n) },
      );
    }
    await ctx.store.putEntity(
      { name: 'i1', entityType: 'Insight', ontologyClass: 'Insight' },
      { provenance: mkProvenance('i1') },
    );
    await ctx.store.putEntity(
      { name: 'c1', entityType: 'Component', ontologyClass: 'Component' },
      { provenance: mkProvenance('c1') },
    );

    expect(await ctx.store.countByOntologyClass('Observation')).toBe(3);
    expect(await ctx.store.countByOntologyClass('Digest')).toBe(2);
    expect(await ctx.store.countByOntologyClass('Insight')).toBe(1);
    // Class with no matches still returns a number (0), not undefined.
    expect(await ctx.store.countByOntologyClass('Pattern')).toBe(0);
  });

  test('countByOntologyClass with predicate filters per-entity', async () => {
    await ctx.store.putEntity(
      {
        name: 'obs-coding',
        entityType: 'Observation',
        ontologyClass: 'Observation',
        metadata: { project: 'coding' },
      },
      { provenance: mkProvenance('1') },
    );
    await ctx.store.putEntity(
      {
        name: 'obs-coding2',
        entityType: 'Observation',
        ontologyClass: 'Observation',
        metadata: { project: 'coding' },
      },
      { provenance: mkProvenance('2') },
    );
    await ctx.store.putEntity(
      {
        name: 'obs-other',
        entityType: 'Observation',
        ontologyClass: 'Observation',
        metadata: { project: 'rapid-automations' },
      },
      { provenance: mkProvenance('3') },
    );
    const total = await ctx.store.countByOntologyClass('Observation');
    const coding = await ctx.store.countByOntologyClass('Observation', {
      predicate: (e) => (e.metadata as { project?: string } | undefined)?.project === 'coding',
    });
    expect(total).toBe(3);
    expect(coding).toBe(2);
  });

  test('lastModifiedByClass returns null for an empty class', async () => {
    // T-44-14-06 mitigation: staleness clock must NOT throw and must NOT
    // return undefined on an empty class. The dashboard COUNT path
    // distinguishes "no data ever" (null) from "data exists" (ISO string).
    const ts = await ctx.store.lastModifiedByClass('Observation');
    expect(ts).toBeNull();
  });

  test('lastModifiedByClass returns the max createdAt across the class', async () => {
    // Three observations with explicit ISO timestamps. ISO-8601 strings
    // compare lexicographically identical to chronological order, so a
    // simple string-max suffices in the implementation.
    await ctx.store.putEntity(
      {
        name: 'old',
        entityType: 'Observation',
        ontologyClass: 'Observation',
        createdAt: '2026-01-01T00:00:00Z',
      },
      { provenance: mkProvenance('old') },
    );
    await ctx.store.putEntity(
      {
        name: 'newest',
        entityType: 'Observation',
        ontologyClass: 'Observation',
        createdAt: '2026-06-04T12:00:00Z',
      },
      { provenance: mkProvenance('newest') },
    );
    await ctx.store.putEntity(
      {
        name: 'middle',
        entityType: 'Observation',
        ontologyClass: 'Observation',
        createdAt: '2026-03-15T08:00:00Z',
      },
      { provenance: mkProvenance('middle') },
    );
    const ts = await ctx.store.lastModifiedByClass('Observation');
    expect(ts).toBe('2026-06-04T12:00:00Z');
  });

  test('lastModifiedByClass ignores entities of other classes', async () => {
    await ctx.store.putEntity(
      {
        name: 'obs',
        entityType: 'Observation',
        ontologyClass: 'Observation',
        createdAt: '2026-01-01T00:00:00Z',
      },
      { provenance: mkProvenance('obs') },
    );
    // A Digest with a LATER timestamp must not influence the Observation
    // staleness clock — the dashboard's three timestamps are per-class.
    await ctx.store.putEntity(
      {
        name: 'dig',
        entityType: 'Digest',
        ontologyClass: 'Digest',
        createdAt: '2026-12-31T23:59:59Z',
      },
      { provenance: mkProvenance('dig') },
    );
    const obsTs = await ctx.store.lastModifiedByClass('Observation');
    const digTs = await ctx.store.lastModifiedByClass('Digest');
    expect(obsTs).toBe('2026-01-01T00:00:00Z');
    expect(digTs).toBe('2026-12-31T23:59:59Z');
  });

  test('findByLegacyId returns the matching entity', async () => {
    // Two observations stamped with system:'A' legacyIds via the trusted
    // path (mirrors how legacy-ingest.ts shapes ObservationWriter output).
    const ePartial = {
      entityType: 'Observation',
      ontologyClass: 'Observation' as string,
      layer: 'evidence' as const,
      description: '',
      createdAt: '2026-06-04T10:00:00Z',
      updatedAt: '2026-06-04T10:00:00Z',
      validFrom: '2026-06-04T10:00:00Z',
      createdBy: mkProvenance('seed'),
    };
    await ctx.store.putEntity(
      {
        ...ePartial,
        name: 'first',
        legacyId: { system: 'A', id: 'row-1' },
      },
      { skipOntologyCheck: true },
    );
    await ctx.store.putEntity(
      {
        ...ePartial,
        name: 'second',
        legacyId: { system: 'A', id: 'row-2' },
      },
      { skipOntologyCheck: true },
    );
    const found = await ctx.store.findByLegacyId({ system: 'A', id: 'row-2' });
    expect(found).toBeDefined();
    expect(found!.name).toBe('second');
    expect(found!.legacyId).toEqual({ system: 'A', id: 'row-2' });
  });

  test('findByLegacyId returns undefined when no match exists', async () => {
    await ctx.store.putEntity(
      {
        name: 'only',
        entityType: 'Observation',
        ontologyClass: 'Observation',
        legacyId: { system: 'A', id: 'row-1' },
        createdBy: mkProvenance('seed'),
      } as unknown as Parameters<typeof ctx.store.putEntity>[0],
      { skipOntologyCheck: true },
    );
    const missing = await ctx.store.findByLegacyId({ system: 'A', id: 'row-99' });
    expect(missing).toBeUndefined();
    // Distinct legacy systems must NOT cross-match — protects against the
    // A/B/C subsystem boundary collapse Phase 41 D-13 warns about.
    const wrongSystem = await ctx.store.findByLegacyId({ system: 'B', id: 'row-1' });
    expect(wrongSystem).toBeUndefined();
  });
});

// Phase 44 Plan 13 — APPENDED tests for `findByContentHash` and
// `findRecentByAgent`. The two helpers back ObservationWriter's dedup +
// semantic-dup helpers in the Plan 13 cutover (drop `this.db`). Sibling
// describe block — do NOT modify the existing blocks above.
describe('findByContentHash / findRecentByAgent (Phase 44 Plan 13)', () => {
  let ctx: Ctx;

  function mkProvenance(suffix: string): ProvenanceStamp {
    return {
      provider: 'test',
      model: 'test-model',
      runId: `run-${suffix}`,
      timestamp: new Date().toISOString(),
    };
  }

  // Helper: seed an Observation-shaped entity matching the legacy-ingest.ts
  // field map (metadata.agent + metadata.content_hash + metadata.createdAt
  // snake-case). Uses the trusted path so we can stamp legacyId verbatim.
  async function seedObservation(
    name: string,
    agent: string,
    contentHash: string,
    createdAt: string,
  ): Promise<void> {
    await ctx.store.putEntity(
      {
        name,
        entityType: 'Observation',
        ontologyClass: 'Observation',
        layer: 'evidence',
        description: name,
        createdAt,
        updatedAt: createdAt,
        validFrom: createdAt,
        metadata: {
          agent,
          content_hash: contentHash,
          createdAt,
          summary: name,
        },
        legacyId: { system: 'A', id: `legacy-${name}` },
        createdBy: mkProvenance(name),
      } as unknown as Parameters<typeof ctx.store.putEntity>[0],
      { skipOntologyCheck: true },
    );
  }

  beforeEach(async () => {
    ctx = makeStore();
    await ctx.store.open();
  });

  afterEach(async () => {
    await ctx.store.close();
    fs.rmSync(ctx.tmpdir, { recursive: true, force: true });
  });

  // ── findByContentHash ──────────────────────────────────────────────────

  test('findByContentHash returns the matching entity for (agent, contentHash)', async () => {
    await seedObservation('o1', 'claude', 'hash-A', '2026-06-04T10:00:00Z');
    await seedObservation('o2', 'claude', 'hash-B', '2026-06-04T10:05:00Z');
    await seedObservation('o3', 'opencode', 'hash-A', '2026-06-04T10:10:00Z');
    await seedObservation('o4', 'copilot', 'hash-C', '2026-06-04T10:15:00Z');
    await seedObservation('o5', 'claude', 'hash-A', '2026-06-04T11:00:00Z');

    const matches = await ctx.store.findByContentHash('claude', 'hash-A');
    expect(matches.length).toBe(2);
    const names = matches.map((e) => e.name).sort();
    expect(names).toEqual(['o1', 'o5']);
  });

  test('findByContentHash returns [] when agent does not match', async () => {
    await seedObservation('o1', 'claude', 'hash-A', '2026-06-04T10:00:00Z');
    const matches = await ctx.store.findByContentHash('opencode', 'hash-A');
    expect(matches).toEqual([]);
  });

  test('findByContentHash returns [] when contentHash does not match', async () => {
    await seedObservation('o1', 'claude', 'hash-A', '2026-06-04T10:00:00Z');
    const matches = await ctx.store.findByContentHash('claude', 'hash-Z');
    expect(matches).toEqual([]);
  });

  test('findByContentHash respects ontologyClass override', async () => {
    // Seed one Observation and one Digest with the SAME (agent, content_hash)
    // — the Observation-default scan must NOT cross-match the Digest.
    await seedObservation('obs', 'claude', 'hash-X', '2026-06-04T10:00:00Z');
    await ctx.store.putEntity(
      {
        name: 'dig',
        entityType: 'Digest',
        ontologyClass: 'Digest',
        layer: 'pattern',
        description: 'a digest',
        createdAt: '2026-06-04T10:00:00Z',
        metadata: { agent: 'claude', content_hash: 'hash-X' },
        createdBy: mkProvenance('dig'),
      } as unknown as Parameters<typeof ctx.store.putEntity>[0],
      { skipOntologyCheck: true },
    );
    const obs = await ctx.store.findByContentHash('claude', 'hash-X');
    expect(obs.length).toBe(1);
    expect(obs[0].name).toBe('obs');
    const digs = await ctx.store.findByContentHash('claude', 'hash-X', {
      ontologyClass: 'Digest',
    });
    expect(digs.length).toBe(1);
    expect(digs[0].name).toBe('dig');
  });

  // ── findRecentByAgent ──────────────────────────────────────────────────

  test('findRecentByAgent returns entities newer than sinceISO, sorted DESC by metadata.createdAt', async () => {
    await seedObservation('oldest', 'claude', 'h1', '2026-06-04T08:00:00Z');
    await seedObservation('mid', 'claude', 'h2', '2026-06-04T10:00:00Z');
    await seedObservation('newest', 'claude', 'h3', '2026-06-04T12:00:00Z');
    await seedObservation('newer-different-agent', 'opencode', 'h4', '2026-06-04T13:00:00Z');

    const since = '2026-06-04T09:00:00Z';
    const matches = await ctx.store.findRecentByAgent('claude', since, 10);
    expect(matches.length).toBe(2);
    // Sorted DESC — newest first.
    expect(matches[0].name).toBe('newest');
    expect(matches[1].name).toBe('mid');
  });

  test('findRecentByAgent truncates to limit', async () => {
    await seedObservation('o1', 'claude', 'h1', '2026-06-04T10:00:00Z');
    await seedObservation('o2', 'claude', 'h2', '2026-06-04T10:05:00Z');
    await seedObservation('o3', 'claude', 'h3', '2026-06-04T10:10:00Z');
    await seedObservation('o4', 'claude', 'h4', '2026-06-04T10:15:00Z');
    await seedObservation('o5', 'claude', 'h5', '2026-06-04T10:20:00Z');

    const since = '2026-06-04T09:00:00Z';
    const matches = await ctx.store.findRecentByAgent('claude', since, 3);
    expect(matches.length).toBe(3);
    expect(matches.map((e) => e.name)).toEqual(['o5', 'o4', 'o3']);
  });

  test('findRecentByAgent returns [] when agent does not match', async () => {
    await seedObservation('o1', 'claude', 'h1', '2026-06-04T10:00:00Z');
    const since = '2026-06-04T00:00:00Z';
    const matches = await ctx.store.findRecentByAgent('opencode', since, 10);
    expect(matches).toEqual([]);
  });

  test('findRecentByAgent excludes entities at-or-before sinceISO', async () => {
    // Use ISO-8601 strings of consistent precision so lexicographic compare
    // matches chronological compare (mixing ".001Z" with "Z" suffixes breaks
    // lexicographic ordering — '.' < 'Z' in ASCII).
    await seedObservation('exactly-at', 'claude', 'h1', '2026-06-04T10:00:00.000Z');
    await seedObservation('one-second-after', 'claude', 'h2', '2026-06-04T10:00:01.000Z');

    // Strict > comparison: an entity stamped exactly at sinceISO is excluded.
    const matches = await ctx.store.findRecentByAgent(
      'claude',
      '2026-06-04T10:00:00.000Z',
      10,
    );
    expect(matches.length).toBe(1);
    expect(matches[0].name).toBe('one-second-after');
  });

  test('findRecentByAgent respects ontologyClass override', async () => {
    await seedObservation('obs', 'claude', 'h1', '2026-06-04T10:00:00Z');
    await ctx.store.putEntity(
      {
        name: 'dig',
        entityType: 'Digest',
        ontologyClass: 'Digest',
        layer: 'pattern',
        description: 'a digest',
        createdAt: '2026-06-04T11:00:00Z',
        metadata: { agent: 'claude', createdAt: '2026-06-04T11:00:00Z' },
        createdBy: mkProvenance('dig'),
      } as unknown as Parameters<typeof ctx.store.putEntity>[0],
      { skipOntologyCheck: true },
    );
    const obs = await ctx.store.findRecentByAgent('claude', '2026-06-04T00:00:00Z', 10);
    expect(obs.length).toBe(1);
    expect(obs[0].name).toBe('obs');
    const digs = await ctx.store.findRecentByAgent('claude', '2026-06-04T00:00:00Z', 10, {
      ontologyClass: 'Digest',
    });
    expect(digs.length).toBe(1);
    expect(digs[0].name).toBe('dig');
  });
});

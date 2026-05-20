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

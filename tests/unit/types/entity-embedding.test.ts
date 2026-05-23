// Phase 42 Plan 04 Task 1: Entity.embedding?: number[] (D-52 schema extension).
//
// Four tests covering:
//   1. Type literal acceptance — `{ embedding: [...] }` compiles as a valid
//      Entity partial.
//   2. Optional field — entities WITHOUT embedding still compile + behave
//      identically (Phase 37-41 fixtures are unaffected).
//   3. Round-trip through putEntity → getNodeAttributes preserves the
//      embedding array element-for-element.
//   4. mergeAttributes (D-37 hot path) accepts an `{ embedding: [...] }`
//      partial and the stored entity reflects it.
//
// Conventions:
//   - vitest describe / test (matches sibling tests/unit/maintenance/*.test.ts).
//   - Fresh in-memory GraphKMStore per test (no shared LevelDB).
//   - PROV: static ProvenanceStamp lifted from mergeEntities.test.ts pattern.

import { describe, test, expect, afterEach, expectTypeOf } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GraphKMStore } from '../../../src/index.js';
import type {
  Entity,
  EntityId,
  ProvenanceStamp,
} from '../../../src/index.js';

interface Ctx {
  store: GraphKMStore;
  tmpdir: string;
}

function makeStoreCtx(): Ctx {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-emb-'));
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
  provider: 'entity-embedding-test',
  model: 'phase-42-plan-04',
  runId: 'test-run-static',
  timestamp: '2026-05-23T00:00:00.000Z',
};

describe('Entity.embedding (Phase 42 D-52 schema extension)', () => {
  // Track contexts so a failing test still releases LevelDB locks.
  const ctxs: Ctx[] = [];
  afterEach(async () => {
    while (ctxs.length > 0) {
      const c = ctxs.pop()!;
      await cleanup(c);
    }
  });

  test('Test 1: TypeScript accepts { embedding: number[] } as a valid Entity literal', () => {
    // Compile-time check: the literal MUST compile. If the field were missing
    // from the Entity interface, this assignment would fail with TS2353
    // ("Object literal may only specify known properties"). The test body's
    // existence at compile time IS the assertion.
    const sample: Partial<Entity> & { embedding: number[] } = {
      name: 'fixture',
      entityType: 'Observation',
      embedding: [0.1, 0.2, 0.3],
    };
    expect(sample.embedding).toEqual([0.1, 0.2, 0.3]);

    // Type-level assertion — Entity has an `embedding` property.
    expectTypeOf<Entity>().toHaveProperty('embedding');
  });

  test('Test 2: embedding is optional — entities without it compile + persist unchanged', async () => {
    const ctx = makeStoreCtx();
    ctxs.push(ctx);
    const { store } = ctx;
    await store.open();

    // No `embedding` field. Compiles cleanly because the field is optional.
    const id = await store.putEntity(
      {
        name: 'no-embedding-entity',
        entityType: 'Observation',
        description: 'baseline phase 37-41 shape',
        layer: 'evidence',
        metadata: {},
      },
      { provenance: PROV },
    );

    // Stored entity has no `embedding` property — round-trip preserves
    // absence (i.e. the field is not auto-populated to `[]` or `undefined`
    // as an own-property).
    const stored = (store as unknown as {
      graph: { getNodeAttributes(id: EntityId): Entity };
    }).graph.getNodeAttributes(id);
    expect(stored.name).toBe('no-embedding-entity');
    expect('embedding' in stored).toBe(false);
  });

  test('Test 3: round-trip via putEntity then getNodeAttributes preserves embedding array', async () => {
    const ctx = makeStoreCtx();
    ctxs.push(ctx);
    const { store } = ctx;
    await store.open();

    const expected = Array.from({ length: 384 }, (_, i) =>
      Math.sin(i) * 0.1,
    );

    const id = await store.putEntity(
      {
        name: 'embedded-entity',
        entityType: 'Detail',
        description: 'with embedding',
        layer: 'evidence',
        metadata: {},
        embedding: expected,
      },
      { provenance: PROV },
    );

    // Read via the iterate API to confirm the public surface preserves
    // the field too.
    let found: Entity | undefined;
    for await (const e of store.iterate()) {
      if (e.id === id) {
        found = e;
        break;
      }
    }
    expect(found).toBeDefined();
    expect(found!.embedding).toEqual(expected);
    expect(found!.embedding!.length).toBe(384);

    // Direct graph read also reflects the same array.
    const stored = (store as unknown as {
      graph: { getNodeAttributes(id: EntityId): Entity };
    }).graph.getNodeAttributes(id);
    expect(stored.embedding).toEqual(expected);
  });

  test('Test 4: mergeAttributes accepts { embedding } partial and updates the node attribute', async () => {
    const ctx = makeStoreCtx();
    ctxs.push(ctx);
    const { store } = ctx;
    await store.open();

    // Seed an entity without an embedding.
    const id = await store.putEntity(
      {
        name: 'merge-target',
        entityType: 'Detail',
        description: 'will get embedding via mergeAttributes',
        layer: 'evidence',
        metadata: {},
      },
      { provenance: PROV },
    );

    // Confirm starting state.
    let stored = (store as unknown as {
      graph: { getNodeAttributes(id: EntityId): Entity };
    }).graph.getNodeAttributes(id);
    expect('embedding' in stored).toBe(false);

    // Apply mergeAttributes with the typed embedding partial.
    const embedding = [0.5, 0.25, 0.125];
    await store.mergeAttributes(id, { embedding });

    stored = (store as unknown as {
      graph: { getNodeAttributes(id: EntityId): Entity };
    }).graph.getNodeAttributes(id);
    expect(stored.embedding).toEqual(embedding);
  });
});

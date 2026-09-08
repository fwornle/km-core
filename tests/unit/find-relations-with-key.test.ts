// findRelations({ withKey }) — the edge key, and why it is opt-in.
//
// BACKGROUND (2026-09-08). `findRelations` returned only the edge ATTRIBUTES,
// dropping the graphology edge id. `relationToWire` therefore fell through to
// its synthetic `<from>|<to>|<type>` key, and `DELETE /relations/:key` looked
// that string up with `graph.hasEdge(key)`. Edges added through POST /relations
// carry a graphology-assigned `geid_…` id instead, so the delete route 404'd on
// them while the list route had just handed the caller a key that looked
// entirely plausible. Eleven stale edges in the coding graph were undeletable
// through the public API because of it.
//
// The flag is opt-in because the key changes what callers DO with the result:
// `addRelation` branches on `r.key` and swallows duplicate-key errors, so a
// read-modify-write caller (mergeEntities) would silently lose edges.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  GraphKMStore,
  type GraphKMStoreOptions,
  type ProvenanceStamp,
  type EntityId,
} from '../../src/index.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PROV: ProvenanceStamp = {
  provider: 'test',
  model: 'test-model',
  runId: 'find-relations-with-key',
  timestamp: '2026-09-08T00:00:00.000Z',
};

type Ctx = { store: GraphKMStore; tmpdir: string; a: EntityId; b: EntityId };

function makeStore(extra?: Partial<GraphKMStoreOptions>) {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-key-'));
  const store = new GraphKMStore({
    dbPath: path.join(tmpdir, 'leveldb'),
    exportDir: path.join(tmpdir, 'exports'),
    debounceMs: 0,
    ...extra,
  });
  return { store, tmpdir };
}

describe('findRelations withKey', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    const { store, tmpdir } = makeStore();
    await store.open();
    const a = await store.putEntity(
      { name: 'A', entityType: 'Component', layer: 'evidence', description: '', metadata: {} },
      { provenance: PROV },
    );
    const b = await store.putEntity(
      { name: 'B', entityType: 'Component', layer: 'evidence', description: '', metadata: {} },
      { provenance: PROV },
    );
    ctx = { store, tmpdir, a, b };
  });

  afterEach(async () => {
    await ctx.store.close();
    fs.rmSync(ctx.tmpdir, { recursive: true, force: true });
  });

  test('an auto-keyed edge reports a key that the graph can actually resolve', async () => {
    // No `key` supplied — graphology assigns its own id. This is the shape
    // every edge created through POST /relations has.
    await ctx.store.addRelation({ from: ctx.a, to: ctx.b, type: 'contains' });

    const [rel] = await ctx.store.findRelations({ type: 'contains' }, { withKey: true });
    expect(rel.key).toBeDefined();

    // The whole point: this key addresses the edge. The synthetic
    // `<from>|<to>|<type>` string never did.
    const graph = (ctx.store as unknown as { graph: { hasEdge: (k: string) => boolean } }).graph;
    expect(graph.hasEdge(rel.key!)).toBe(true);
    expect(graph.hasEdge(`${ctx.a}|${ctx.b}|contains`)).toBe(false);
  });

  test('an explicitly-keyed edge reports that key verbatim', async () => {
    const key = `${ctx.a}|${ctx.b}|includes`;
    await ctx.store.addRelation({ from: ctx.a, to: ctx.b, type: 'includes', key });
    const [rel] = await ctx.store.findRelations({ type: 'includes' }, { withKey: true });
    expect(rel.key).toBe(key);
  });

  test('omitting the flag returns no key — the default is unchanged', async () => {
    await ctx.store.addRelation({ from: ctx.a, to: ctx.b, type: 'contains' });
    const [rel] = await ctx.store.findRelations({ type: 'contains' });
    expect(rel.key).toBeUndefined();
  });

  test('the key is on a copy — it never reaches the stored edge attributes', async () => {
    // getEdgeAttributes hands back the LIVE object. Writing `key` onto it would
    // persist a key field into every edge of the exported graph.
    await ctx.store.addRelation({ from: ctx.a, to: ctx.b, type: 'contains' });
    await ctx.store.findRelations({}, { withKey: true });

    const graph = (ctx.store as unknown as {
      graph: { edges: () => string[]; getEdgeAttributes: (k: string) => Record<string, unknown> };
    }).graph;
    for (const e of graph.edges()) {
      expect(graph.getEdgeAttributes(e).key).toBeUndefined();
    }
  });

  test('a read-modify-write caller keeps its edges (why the flag is opt-in)', async () => {
    // mergeEntities reads a duplicate's edges and re-adds them pointing at the
    // survivor. If the read carried the original key, addRelation would take
    // the addDirectedEdgeWithKey branch, collide with the edge still present,
    // swallow the error, and drop the rewritten edge.
    const c = await ctx.store.putEntity(
      { name: 'C', entityType: 'Component', layer: 'evidence', description: '', metadata: {} },
      { provenance: PROV },
    );
    await ctx.store.addRelation({ from: ctx.a, to: ctx.b, type: 'contains' });

    const edges = await ctx.store.findRelations({ from: ctx.a });
    for (const e of edges) {
      await ctx.store.addRelation({ ...e, to: c });
    }

    const rewritten = await ctx.store.findRelations({ from: ctx.a, to: c });
    expect(rewritten).toHaveLength(1);
  });

  test('filters still apply with the flag on', async () => {
    await ctx.store.addRelation({ from: ctx.a, to: ctx.b, type: 'contains' });
    await ctx.store.addRelation({ from: ctx.b, to: ctx.a, type: 'includes' });

    const contains = await ctx.store.findRelations({ type: 'contains' }, { withKey: true });
    expect(contains).toHaveLength(1);
    expect(contains[0].from).toBe(ctx.a);

    const fromB = await ctx.store.findRelations({ from: ctx.b }, { withKey: true });
    expect(fromB).toHaveLength(1);
    expect(fromB[0].type).toBe('includes');
  });
});

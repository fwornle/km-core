// Union merge of graph copies (store/merge.ts) and the per-repo layout it
// serves: two stores writing their own files must converge when each merges
// the other's, deletions included.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GraphKMStore } from '../../src/store/GraphKMStore.js';
import { mergeGraphs, relationKey, TOMBSTONES_ATTR } from '../../src/store/merge.js';
import type { ExportLayout } from '../../src/store/layout.js';
import type { SerializedGraph } from '../../src/types/entity.js';
import { mintEntityId } from '../../src/ids/mint.js';

const OPTS = { type: 'directed', multi: true, allowSelfLoops: true };

function node(key: string, updatedAt: string, extra: Record<string, unknown> = {}) {
  return { key, attributes: { id: key, name: key, updatedAt, createdAt: updatedAt, metadata: {}, ...extra } as never };
}
function edge(key: string, source: string, target: string, type = 'contains', createdAt = '2026-01-01T00:00:00Z') {
  return { key, source, target, attributes: { from: source, to: target, type, createdAt } as never };
}
function g(nodes: unknown[], edges: unknown[] = [], attributes: Record<string, unknown> = {}): SerializedGraph {
  return { attributes, options: OPTS, nodes, edges } as SerializedGraph;
}

describe('mergeGraphs', () => {
  test('newest updatedAt wins per entity; ties keep the first source', () => {
    const a = g([node('x', '2026-01-02T00:00:00Z', { name: 'A-new' }), node('y', '2026-01-01T00:00:00Z', { name: 'A' })]);
    const b = g([node('x', '2026-01-01T00:00:00Z', { name: 'B-old' }), node('y', '2026-01-01T00:00:00Z', { name: 'B' }), node('z', '2026-01-01T00:00:00Z')]);
    const { graph, stats } = mergeGraphs([b, a]);
    const by = Object.fromEntries(graph.nodes.map((n) => [n.key, (n.attributes as { name: string }).name]));
    expect(by).toEqual({ x: 'A-new', y: 'B', z: 'z' });
    expect(stats.replaced).toBe(1);
  });

  test('relations match by (from,type,to), not by edge key', () => {
    const a = g([node('x', '2026-01-01T00:00:00Z'), node('y', '2026-01-01T00:00:00Z')], [edge('geid_1_0', 'x', 'y')]);
    const b = g([node('x', '2026-01-01T00:00:00Z'), node('y', '2026-01-01T00:00:00Z')], [edge('geid_1_0', 'y', 'x'), edge('geid_9_9', 'x', 'y')]);
    const { graph } = mergeGraphs([a, b]);
    expect(graph.edges).toHaveLength(2);
    expect(new Set(graph.edges.map((e) => e.key)).size).toBe(2); // the colliding key was renamed
  });

  test('a tombstone beats every copy not edited after it', () => {
    const del = { entities: { x: { at: '2026-01-05T00:00:00Z' }, y: { at: '2026-01-05T00:00:00Z' } }, relations: {} };
    const a = g([], [], { [TOMBSTONES_ATTR]: del });
    const b = g([node('x', '2026-01-01T00:00:00Z'), node('y', '2026-01-09T00:00:00Z')]);
    const { graph, stats } = mergeGraphs([a, b]);
    expect(graph.nodes.map((n) => n.key)).toEqual(['y']);
    expect(stats.tombstoned).toBe(1);
  });

  test('a relation tombstone removes the relation; endpoints stay', () => {
    const stones = { entities: {}, relations: { [relationKey('x', 'contains', 'y')]: { at: '2026-02-01T00:00:00Z' } } };
    const a = g([node('x', '2026-01-01T00:00:00Z'), node('y', '2026-01-01T00:00:00Z')], [], { [TOMBSTONES_ATTR]: stones });
    const b = g([node('x', '2026-01-01T00:00:00Z'), node('y', '2026-01-01T00:00:00Z')], [edge('e', 'x', 'y')]);
    const { graph } = mergeGraphs([a, b]);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(0);
  });

  test('a relation to an entity absent here is kept aside, not dropped', () => {
    const a = g([node('x', '2026-01-01T00:00:00Z')], [edge('e', 'x', 'elsewhere')]);
    const { graph, dangling } = mergeGraphs([null, a]);
    expect(graph.edges).toHaveLength(0);
    expect(dangling).toEqual([{ edge: a.edges[0], source: 1 }]);
  });
});

describe('GraphKMStore with a per-project layout', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-layout-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  // Each "machine" files project P in a shared dir (the learning checkout
  // both clone) and everything else in its own local dir.
  function layout(shared: string, local: string): ExportLayout {
    const fileFor = (b: string) => path.join(b === 'p' ? shared : local, `${b}.json`);
    return {
      bucketOf: (m) => String(m?.project ?? 'misc'),
      fileFor,
      sources: () => [fileFor('p'), fileFor('misc')],
      owns: (f) => path.dirname(f) === local,
      canonicalOrder: true,
    };
  }
  function store(machine: string, shared: string) {
    const local = path.join(tmp, machine, 'local');
    return new GraphKMStore({
      dbPath: path.join(tmp, machine, 'leveldb'),
      exportDir: local,
      layout: layout(shared, local),
      debounceMs: 0,
    });
  }
  async function put(s: GraphKMStore, name: string, project: string, id = mintEntityId()) {
    // The trusted path stamps nothing, so stamp updatedAt the way the strict
    // path would — the merge decides on it.
    const updatedAt = new Date().toISOString();
    await s.putEntity({ id, name, entityType: 'Insight', layer: 'evidence' as never, description: name, updatedAt, metadata: { project } } as never, { skipOntologyCheck: true });
    return id;
  }
  const names = async (s: GraphKMStore) => {
    const out: string[] = [];
    for await (const e of s.iterate()) out.push(e.name);
    return out.sort();
  };

  test('files by project, and a second machine sees the first one\'s entities', async () => {
    const shared = path.join(tmp, 'shared');
    const a = store('a', shared);
    await a.open();
    await put(a, 'shared-insight', 'p');
    await put(a, 'private-note', 'q');
    await a.exportJson();
    await a.close();
    const sharedFile = JSON.parse(fs.readFileSync(path.join(shared, 'p.json'), 'utf-8'));
    expect(sharedFile.nodes.map((n: { attributes: { name: string } }) => n.attributes.name)).toEqual(['shared-insight']);

    const b = store('b', shared);
    await b.open();
    expect(await names(b)).toEqual(['shared-insight']); // q stayed on machine a
    await b.close();
  });

  test('concurrent edits merge; a deletion travels', async () => {
    const shared = path.join(tmp, 'shared');
    const a = store('a', shared);
    await a.open();
    const keep = await put(a, 'keep', 'p');
    const doomed = await put(a, 'doomed', 'p');
    await a.exportJson();

    const b = store('b', shared);
    await b.open();
    expect(await names(b)).toEqual(['doomed', 'keep']);

    // b deletes and adds; a edits — then each merges the other's file.
    await b.deleteEntity(doomed as never);
    await put(b, 'from-b', 'p');
    await b.exportJson();
    await new Promise((r) => setTimeout(r, 5));
    await put(a, 'keep-edited-by-a', 'p', keep);
    const stats = await a.reloadSources();
    expect(stats.removed).toBe(1);
    expect(stats.added).toBe(1);
    expect(await names(a)).toEqual(['from-b', 'keep-edited-by-a']);

    await a.exportJson();
    await b.reloadSources();
    expect(await names(b)).toEqual(['from-b', 'keep-edited-by-a']);
    await a.close();
    await b.close();
  });

  test('a file changed under the store (git pull) is merged, not overwritten', async () => {
    const shared = path.join(tmp, 'shared');
    const a = store('a', shared);
    await a.open();
    await put(a, 'mine', 'p');
    await a.exportJson();

    // Another machine's version of the same file arrives (a merge in the
    // learning checkout): it has an entity this store never saw.
    const b = store('b', shared);
    await b.open();
    await put(b, 'theirs', 'p');
    await b.exportJson();
    await b.close();

    // a mutates before anyone told it to reload: its export must not
    // clobber 'theirs'.
    let reloaded: unknown = null;
    a.once('store:reloaded', (s) => { reloaded = s; });
    await put(a, 'mine-too', 'p');
    await a.exportJson();
    const onDisk = () => JSON.parse(fs.readFileSync(path.join(shared, 'p.json'), 'utf-8'))
      .nodes.map((n: { attributes: { name: string } }) => n.attributes.name).sort();
    expect(onDisk()).toContain('theirs');
    await new Promise((r) => setTimeout(r, 50)); // reload is fire-and-forget
    expect(reloaded).not.toBeNull();
    expect(await names(a)).toEqual(['mine', 'mine-too', 'theirs']);
    await a.exportJson();
    expect(onDisk()).toEqual(['mine', 'mine-too', 'theirs']);
    await a.close();
  });

  test('an unchanged graph does not rewrite its files', async () => {
    const shared = path.join(tmp, 'shared');
    const a = store('a', shared);
    await a.open();
    await put(a, 'x', 'p');
    await a.exportJson();
    const file = path.join(shared, 'p.json');
    const before = fs.statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await a.exportJson();
    expect(fs.statSync(file).mtimeMs).toBe(before);
    await a.close();
  });
});

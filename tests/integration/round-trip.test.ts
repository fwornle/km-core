// Option B (Phase 37 Plan 01): B's fixture uses _convert-b.ts shim. The shim
// disappears in Phase 42 when B's exporter natively emits Graphology shape.
//
// CORE-02 parity + CORE-03 ID survival across all 4 fixtures.
//
// Security: this test exercises threat T-37-02 (untrusted JSON during snapshot
// import). All reads are scoped under tests/fixtures/ via path.resolve;
// JSON.parse only (no eval, no Function() constructor).
//
// Wave 0 RED state: `GraphKMStore` not yet exported from '../../src/index.js'.
// Plan 04 (CORE-02) makes these GREEN.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { GraphKMStore } from '../../src/index.js';
import { MultiDirectedGraph } from 'graphology';
import { convertBToGraphology, type BSnapshot } from '../fixtures/_convert-b.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const fixturesDir = path.resolve(__dirname, '..', 'fixtures');

function readFixture(name: string): unknown {
  // path.resolve scopes the read under tests/fixtures/ (no '..' traversal).
  const full = path.resolve(fixturesDir, name);
  // Defense-in-depth: enforce the resolved path stays under fixturesDir.
  if (!full.startsWith(fixturesDir + path.sep)) {
    throw new Error(`Refusing to read outside fixtures dir: ${full}`);
  }
  return JSON.parse(fs.readFileSync(full, 'utf-8'));
}

// Recursive canonical key-sort: ensures byte-equal comparison is order-invariant.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

interface SerializedGraphLike {
  nodes: Array<{ key: string; attributes?: Record<string, unknown> }>;
  edges: Array<{ key?: string; source: string; target: string; attributes?: Record<string, unknown> }>;
  attributes?: Record<string, unknown>;
  options?: Record<string, unknown>;
}

const fixtures = [
  { name: 'b-coding', file: 'b-coding-snapshot.json', isBShape: true },
  { name: 'c-raas', file: 'c-raas-snapshot.json', isBShape: false },
  { name: 'c-kpifw', file: 'c-kpifw-snapshot.json', isBShape: false },
  { name: 'c-general', file: 'c-general-snapshot.json', isBShape: false },
];

describe('round-trip parity', () => {
  let tmpdir: string;
  let store: GraphKMStore;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-roundtrip-'));
    store = new GraphKMStore({
      dbPath: path.join(tmpdir, 'leveldb'),
      exportDir: path.join(tmpdir, 'exports'),
      debounceMs: 0,
    });
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  for (const fixture of fixtures) {
    test(`${fixture.name}: import then exportJson produces byte-equal canonical JSON`, async () => {
      const raw = readFixture(fixture.file);
      // Shape-aware load: B's snapshot uses the legacy {entities, relations}
      // shape and needs the one-time converter; the 3 C snapshots are already
      // Graphology SerializedGraph shape.
      const serialized: SerializedGraphLike = fixture.isBShape
        ? (convertBToGraphology(raw as BSnapshot) as unknown as SerializedGraphLike)
        : (raw as SerializedGraphLike);

      const graph = MultiDirectedGraph.from(
        serialized as unknown as ConstructorParameters<typeof MultiDirectedGraph.from>[0],
      );

      await store.open();
      // Replay nodes and edges into the store (skipOntologyCheck so fixture
      // entityTypes that the v0.1 validator hasn't been wired for still pass).
      for (const nodeId of graph.nodes()) {
        const attrs = graph.getNodeAttributes(nodeId) as Record<string, unknown>;
        await store.putEntity(
          { ...attrs, id: nodeId } as Parameters<GraphKMStore['putEntity']>[0],
          { skipOntologyCheck: true },
        );
      }
      for (const edgeId of graph.edges()) {
        const attrs = graph.getEdgeAttributes(edgeId) as Record<string, unknown>;
        const source = graph.source(edgeId);
        const target = graph.target(edgeId);
        await store.addRelation({
          ...(attrs as Record<string, unknown>),
          type: (attrs as { type?: string }).type ?? 'unknown',
          from: source,
          to: target,
        } as Parameters<GraphKMStore['addRelation']>[0]);
      }

      await store.exportJson();

      // Re-read all written exports, build a round-tripped SerializedGraph.
      const roundTripped: SerializedGraphLike = {
        attributes: serialized.attributes ?? {},
        options: serialized.options ?? {},
        nodes: [],
        edges: [],
      };
      const exportsDir = path.join(tmpdir, 'exports');
      for (const file of fs.readdirSync(exportsDir)) {
        if (!file.endsWith('.json')) continue;
        const part = JSON.parse(
          fs.readFileSync(path.join(exportsDir, file), 'utf-8'),
        ) as SerializedGraphLike;
        roundTripped.nodes.push(...(part.nodes ?? []));
        roundTripped.edges.push(...(part.edges ?? []));
      }

      const canonicalOriginal = JSON.stringify(canonicalize(serialized), null, 0);
      const canonicalRound = JSON.stringify(canonicalize(roundTripped), null, 0);
      expect(canonicalRound).toBe(canonicalOriginal);

      // CORE-03 ID survival: every original node id must appear unchanged.
      const originalIds = new Set(serialized.nodes.map((n) => n.key));
      const roundIds = new Set(roundTripped.nodes.map((n) => n.key));
      for (const id of originalIds) {
        expect(roundIds.has(id)).toBe(true);
      }
    });
  }
});

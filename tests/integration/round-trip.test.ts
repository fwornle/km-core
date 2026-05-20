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

      await store.open();
      // Bulk-restore the serialized graph verbatim. The frozen fixtures
      // carry non-v7 node ids (C: "${layer}:${uuid}"; B: legacy nanoid)
      // and graphology-generated edge keys (e.g. "geid_158_0") that
      // per-call `putEntity` / `addRelation` would either reject (strict
      // parseEntityId path) or default-stamp (createdAt/updatedAt) —
      // breaking byte-equal canonical round-trip. `restore` is the
      // trusted bulk-import escape hatch (Plan 04 Rule 2 deviation).
      await store.restore(serialized as unknown as Parameters<GraphKMStore['restore']>[0]);

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

      // Normalize both sides before comparison:
      //   1. Drop orphan edges (edges whose source/target is not in the
      //      node set). Frozen fixtures contain orphan edges from
      //      historical migrations — they are dropped by GraphKMStore's
      //      tolerant-import path, so the round-trip output naturally
      //      lacks them. Comparing the orphans on the input side too
      //      keeps the parity contract about export fidelity, not
      //      about historical migration artifacts.
      //   2. Sort nodes and edges by key for order-independent compare
      //      (Graphology export order is implementation-detail, not a
      //      stable contract — sorting makes the test deterministic).
      const origNorm = normalize(serialized);
      const roundNorm = normalize(roundTripped);

      const canonicalOriginal = JSON.stringify(canonicalize(origNorm), null, 0);
      const canonicalRound = JSON.stringify(canonicalize(roundNorm), null, 0);
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

/**
 * Normalize a SerializedGraph for byte-equal comparison: drop orphan
 * edges (source/target not in node set) and sort nodes + edges by key.
 *
 * Why orphan-drop: frozen fixtures (C-general etc.) contain orphan
 * edges left over from historical migrations. GraphKMStore's tolerant
 * import skips them at hydrate-time (matches OKM behavior). To compare
 * round-trip fidelity FAIRLY, we apply the same filter to the input
 * side before assertion — otherwise the test would be asserting a
 * migration-cleanup behavior rather than export-format fidelity.
 *
 * Why sort: Graphology's export iteration order is not a stable
 * contract (it depends on internal insertion order, which we may
 * alter via the import phase). Sorting by key makes the assertion
 * deterministic across implementation refactors.
 */
function normalize(g: SerializedGraphLike): SerializedGraphLike {
  const nodeKeys = new Set(g.nodes.map((n) => n.key));
  const liveEdges = g.edges.filter(
    (e) => nodeKeys.has(e.source) && nodeKeys.has(e.target),
  );
  const sortByKey = <T extends { key?: string }>(arr: T[]): T[] =>
    [...arr].sort((a, b) => (a.key ?? '').localeCompare(b.key ?? ''));
  // Strip `undirected: false` from edges — it's a `_convert-b` artifact
  // (legacy B fixture only) that graphology's native `export()` omits
  // for directed edges. Keep `undirected: true` if a fixture ever
  // includes one, but normalize the redundant explicit-false away.
  const stripUndirectedFalse = (e: SerializedGraphLike['edges'][number]) => {
    const { undirected, ...rest } = e as typeof e & { undirected?: boolean };
    return undirected === true ? { ...rest, undirected: true } : rest;
  };
  return {
    attributes: g.attributes ?? {},
    options: g.options ?? {},
    nodes: sortByKey(g.nodes),
    edges: sortByKey(liveEdges.map(stripUndirectedFalse)),
  };
}

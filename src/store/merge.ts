// Union merge of serialized graphs — how several copies of one knowledge base
// become one.
//
// WHY: a knowledge base is persisted in more than one place (LevelDB, the JSON
// export of every repo it learned in, a teammate's copy of the same repo that
// arrived by `git pull`). The old hydrate picked ONE copy by node count, so a
// teammate's edit to an entity this machine also had was ignored, and a copy
// with fewer nodes lost even when it was newer. Merging instead:
//
//   - entities are matched by id; the copy with the newest `updatedAt` wins
//     (ties keep the first source's copy, so passing LevelDB first makes the
//     local copy win a tie);
//   - relations are matched by (from, type, to) — `addRelation` is an upsert
//     on that triple, so it is the relation's identity. Graphology's edge KEY
//     is not: auto-minted keys (`geid_<n>_<m>`) are per process, so two
//     machines mint the same key for different edges;
//   - deletions travel as TOMBSTONES (`attributes.kmTombstones`). A deleted
//     entity that is absent from one copy and present in another would
//     otherwise come back from the copy that still has it. A tombstone wins
//     over any copy whose `updatedAt` is not newer than the deletion — so an
//     entity edited after someone else deleted it survives;
//   - provenance is kept: the winning copy is taken whole, never field-merged,
//     so `metadata.provenance` always describes the copy it sits on.

import type { SerializedGraph } from '../types/entity.js';

/** One deletion. `meta` carries just enough of the deleted entity (its
 *  project / team / domain) for an export layout to file the tombstone in the
 *  same place the entity was filed. */
export interface Tombstone {
  at: string;
  meta?: Record<string, unknown>;
}

export interface Tombstones {
  entities: Record<string, Tombstone>;
  relations: Record<string, Tombstone>;
}

export const TOMBSTONES_ATTR = 'kmTombstones';

type Node = SerializedGraph['nodes'][number];
type Edge = SerializedGraph['edges'][number];

/** The identity of a relation: an upsert key, not the graphology edge key. */
export function relationKey(from: string, type: string, to: string): string {
  return `${from}\u0000${type}\u0000${to}`;
}

function edgeTriple(e: Edge): string {
  const a = (e.attributes ?? {}) as { type?: string };
  return relationKey(e.source, String(a.type ?? ''), e.target);
}

function ms(s: unknown): number {
  if (typeof s !== 'string' || s === '') return 0;
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

function nodeStamp(n: Node): number {
  const a = n.attributes as { updatedAt?: string; createdAt?: string } | undefined;
  return ms(a?.updatedAt) || ms(a?.createdAt);
}

function edgeStamp(e: Edge): number {
  const a = (e.attributes ?? {}) as { createdAt?: string; metadata?: { updatedAt?: string; createdAt?: string } };
  return ms(a.metadata?.updatedAt) || ms(a.createdAt) || ms(a.metadata?.createdAt);
}

/** Tombstones carried by one serialized graph (empty when it has none). */
export function tombstonesOf(g: SerializedGraph | null | undefined): Tombstones {
  const raw = (g?.attributes?.[TOMBSTONES_ATTR] ?? {}) as Partial<Tombstones>;
  return { entities: { ...(raw.entities ?? {}) }, relations: { ...(raw.relations ?? {}) } };
}

function unionTombstones(into: Tombstones, from: Tombstones): void {
  for (const kind of ['entities', 'relations'] as const) {
    for (const [k, t] of Object.entries(from[kind])) {
      const prev = into[kind][k];
      if (!prev || ms(t.at) > ms(prev.at)) into[kind][k] = t;
    }
  }
}

/** Drop tombstones older than `ttlMs`. A copy that has not been merged for
 *  longer than that can resurrect what was deleted — the price of not
 *  carrying every deletion forever. */
export function pruneTombstones(t: Tombstones, ttlMs: number, now = Date.now()): Tombstones {
  const keep = (rec: Record<string, Tombstone>) =>
    Object.fromEntries(Object.entries(rec).filter(([, v]) => now - ms(v.at) <= ttlMs));
  return { entities: keep(t.entities), relations: keep(t.relations) };
}

export interface MergeStats {
  sources: number;
  nodes: number;
  edges: number;
  /** Entities for which a later source beat an earlier one. */
  replaced: number;
  /** Entities / relations dropped because a tombstone was newer. */
  tombstoned: number;
  /** Relations kept aside because an endpoint is in no source here. */
  dangling: number;
}

/** A relation whose endpoint this machine does not have (it lives in a repo
 *  that is not checked out here). It cannot enter the in-memory graph, but it
 *  must not be dropped from the export it came from either — that file is
 *  shared, and the teammate who has both endpoints would lose the edge on
 *  the next push. `source` is the index of the input it was read from. */
export interface DanglingEdge {
  edge: Edge;
  source: number;
}

/**
 * Merge serialized graphs into one. `null` entries (a source that does not
 * exist) are skipped. Graph-level attributes other than tombstones come from
 * the first non-null source.
 */
export function mergeGraphs(
  sources: ReadonlyArray<SerializedGraph | null | undefined>,
): { graph: SerializedGraph; stats: MergeStats; dangling: DanglingEdge[] } {
  const present = sources.filter((s): s is SerializedGraph => !!s);
  const indexOf = new Map<SerializedGraph, number>();
  sources.forEach((s, i) => { if (s) indexOf.set(s, i); });
  const stones: Tombstones = { entities: {}, relations: {} };
  for (const s of present) unionTombstones(stones, tombstonesOf(s));

  const nodes = new Map<string, Node>();
  let replaced = 0;
  for (const s of present) {
    for (const n of s.nodes ?? []) {
      const prev = nodes.get(n.key);
      if (!prev) nodes.set(n.key, n);
      else if (nodeStamp(n) > nodeStamp(prev)) {
        nodes.set(n.key, n);
        replaced++;
      }
    }
  }
  let tombstoned = 0;
  for (const [key, n] of nodes) {
    const t = stones.entities[key];
    if (t && ms(t.at) >= nodeStamp(n)) {
      nodes.delete(key);
      tombstoned++;
    }
  }

  const edges = new Map<string, Edge>();
  const origin = new Map<string, number>();
  const usedKeys = new Set<string>();
  for (const s of present) {
    for (const e of s.edges ?? []) {
      const triple = edgeTriple(e);
      if (!origin.has(triple)) origin.set(triple, indexOf.get(s) ?? 0);
      const prev = edges.get(triple);
      if (prev) {
        if (edgeStamp(e) > edgeStamp(prev)) edges.set(triple, { ...e, key: prev.key });
        continue;
      }
      let key = e.key;
      for (let i = 1; usedKeys.has(key); i++) key = `${e.key}~${i}`;
      usedKeys.add(key);
      edges.set(triple, key === e.key ? e : { ...e, key });
    }
  }
  const dangling: DanglingEdge[] = [];
  for (const [triple, e] of edges) {
    const t = stones.relations[triple];
    if (t && ms(t.at) >= edgeStamp(e)) {
      edges.delete(triple);
      tombstoned++;
      continue;
    }
    if (nodes.has(e.source) && nodes.has(e.target)) continue;
    edges.delete(triple);
    // An endpoint deleted here takes the edge with it; one that is merely
    // absent (not checked out on this machine) does not.
    if (stones.entities[e.source] || stones.entities[e.target]) { tombstoned++; continue; }
    dangling.push({ edge: e, source: origin.get(triple) ?? 0 });
  }

  const first = present[0];
  const graph: SerializedGraph = {
    attributes: { ...(first?.attributes ?? {}), [TOMBSTONES_ATTR]: stones },
    options: first?.options ?? { type: 'directed', multi: true, allowSelfLoops: true },
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  };
  return {
    graph,
    stats: { sources: present.length, nodes: graph.nodes.length, edges: graph.edges.length, replaced, tombstoned, dangling: dangling.length },
    dangling,
  };
}

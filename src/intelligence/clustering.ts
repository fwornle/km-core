// Phase 44 Plan 06 (C-3 + RESEARCH Open Q3): Louvain clustering port lifted INTO
// km-core. Dependency direction enforced — km-core MUST NOT depend on OKM.
//
// SOURCE:
//   - 44-CONTEXT.md §C-3: "Add /clusters on top of OKM's surface" using a Louvain
//     implementation. Originally OKM's `src/intelligence/clustering.ts` was a
//     candidate dep; 44-RESEARCH.md §Open Q3 explicitly endorses LIFTING the pure
//     function into km-core (graceful-degradation: km-core never depends on OKM).
//   - 44-PATTERNS.md §clusters.ts: Louvain port at lib/km-core/src/intelligence/
//     clustering.ts; graphology-communities-louvain dep added to km-core.
//
// LIBRARY: graphology-communities-louvain ^2.0.2 — same author org as graphology
// (yomguithereal), MIT, ~47kB unpacked. Standard graphology plugin; documented at
// https://github.com/graphology/graphology#readme. Trust verified via `npm view`
// before install (44-06 threat T-44-06-SC mitigation).
//
// no-console-log: this module is pure — no I/O, no diagnostic emission.
// no-evolutionary-names: file is EXACTLY `clustering.ts`. No -v2 / -enhanced /
// -port variants.

// graphology / graphology-communities-louvain rely on CJS interop for default
// imports. Both packages ship type defs via graphology-types but the d.ts
// shape uses `declare const x; export default x` which TS resolves
// incompatibly across CJS/ESM. We type the inputs loosely (Graph as a
// structural shape we actually call) and runtime-detect default vs namespace
// for the louvain callable.
//
// Public surface: clusterEntities accepts a Graphology Graph (loosely typed as
// `LouvainGraphInput` to allow either Graph<Attributes,...> or
// MultiDirectedGraph<Entity, Relation> via structural compatibility).
import * as louvainNs from 'graphology-communities-louvain';

/** Structural shape clusterEntities calls. Both Graph and MultiDirectedGraph
 *  satisfy this without needing to align type parameters. */
export interface LouvainGraphInput {
  order: number;
}

// Resolve the runtime louvain callable across CJS/ESM interop shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const louvain: (graph: any, opts?: { rng?: () => number; resolution?: number }) => Record<string, number> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (((louvainNs as unknown as { default?: unknown }).default ?? louvainNs) as any);

// ----------------------------------------------------------------------------
// Public types
// ----------------------------------------------------------------------------

export interface ClusterEntitiesOptions {
  /** Clustering algorithm to use. Only 'louvain' is supported in this phase. */
  algorithm?: 'louvain';
  /**
   * Seed for the PRNG used by the Louvain implementation. When supplied, the
   * partition is deterministic given the same input graph. When omitted,
   * Math.random is used and results vary run-to-run.
   */
  seed?: number;
  /**
   * Minimum cluster size. Communities with fewer than `minSize` members are
   * filtered out of the returned list. Default 1 (no filtering).
   */
  minSize?: number;
}

export interface Cluster {
  /** Community id assigned by the Louvain pass (integer or string). */
  communityId: string | number;
  /** Number of members in the community after minSize filtering. */
  size: number;
  /** Node ids belonging to this community. */
  members: string[];
}

// ----------------------------------------------------------------------------
// Seeded PRNG — mulberry32 (6 LOC, standard impl). Used to make Louvain
// deterministic given a `seed`. graphology-communities-louvain accepts any
// `rng: () => number` (a Math.random-compatible function).
// ----------------------------------------------------------------------------

/**
 * Build a deterministic PRNG from a 32-bit integer seed. Returns a function
 * with the same shape as `Math.random` (no arguments, returns a float in
 * [0, 1)). Standard mulberry32 implementation.
 */
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ----------------------------------------------------------------------------
// clusterEntities
// ----------------------------------------------------------------------------

/**
 * Run Louvain community detection over a Graphology graph and return clusters
 * sorted by descending size. Pure synchronous function; no store coupling, no
 * I/O, no diagnostic emission.
 *
 * @param graph A Graphology graph (typed loosely as `Graph` to avoid pulling in
 *   the MultiDirectedGraph<Entity, Relation> type — clustering does not care
 *   about node/edge attribute shapes, only structure).
 * @param opts.algorithm Must be 'louvain' (the only algorithm supported in
 *   Phase 44). Defaults to 'louvain' when omitted.
 * @param opts.seed Optional PRNG seed for deterministic partitions.
 * @param opts.minSize Optional minimum cluster size (default 1 = no filtering).
 *
 * @returns Array of `{ communityId, size, members }` sorted by size desc.
 *   Empty array when the graph has zero nodes.
 */
export function clusterEntities(
  graph: LouvainGraphInput,
  opts: ClusterEntitiesOptions = {},
): Cluster[] {
  const algorithm = opts.algorithm ?? 'louvain';
  if (algorithm !== 'louvain') {
    throw new Error(
      `clusterEntities: unsupported algorithm ${JSON.stringify(algorithm)} ` +
        `(only 'louvain' is supported in Phase 44)`,
    );
  }
  if (graph.order === 0) return [];

  const minSize = Math.max(1, opts.minSize ?? 1);

  // Build the Louvain options object. graphology-communities-louvain accepts:
  //   - rng:        a Math.random-compatible function (deterministic when seeded).
  //   - resolution: the resolution parameter for the modularity objective.
  //
  // Pure function, no side effects. Returns a Record<nodeId, communityId>.
  const louvainOpts: { rng?: () => number; resolution?: number } = {
    resolution: 1.0,
  };
  if (opts.seed !== undefined) {
    louvainOpts.rng = seededRng(opts.seed);
  }
  const partition = louvain(graph, louvainOpts) as Record<string, number>;

  // Group node ids by community id.
  const groups = new Map<string | number, string[]>();
  for (const [nodeId, communityId] of Object.entries(partition)) {
    let bucket = groups.get(communityId);
    if (!bucket) {
      bucket = [];
      groups.set(communityId, bucket);
    }
    bucket.push(nodeId);
  }

  // Materialize clusters, apply minSize filter, sort by size desc (ties broken
  // by communityId for determinism).
  const clusters: Cluster[] = [];
  for (const [communityId, members] of groups.entries()) {
    if (members.length < minSize) continue;
    clusters.push({
      communityId,
      size: members.length,
      members,
    });
  }
  clusters.sort((a, b) => {
    if (b.size !== a.size) return b.size - a.size;
    return String(a.communityId).localeCompare(String(b.communityId));
  });
  return clusters;
}

// Phase 44 Plan 06: Louvain clustering handler for the canonical /api/v1 surface.
//
// SOURCE:
//   - 44-CONTEXT.md §C-3 — `/api/v1/clusters` uses a Louvain implementation
//     LIFTED INTO km-core (RESEARCH §Open Q3). km-core MUST NOT depend on OKM.
//   - 44-PATTERNS.md §clusters.ts — directs import to `intelligence/clustering`.
//   - 44-PATTERNS.md §Shared Patterns — `{success:true,data}` envelope.
//
// 2026-06-03 amendment (44-CONTEXT-amendment.md):
//   - Wire shape per OKM rest-contract.test.ts:164-170:
//       { clusters: [{id, nodeIds, size}], count, modularity }
//     `id` is a non-negative integer (assigned 0..N by index); `nodeIds` is
//     the list of node ids in the community; `size` = nodeIds.length.
//   - RNG seed pinned to OKM's `0x43_06_5E_ED` by default to satisfy the
//     fixture lock at OKM tests/fixtures/pre-migration/api-clusters.json.
//     Caller can override via `?seed=<int>`.
//   - `modularity` is computed by the Louvain plugin; expose via the
//     intelligence/clustering port's optional `modularity` return field
//     (NaN tolerated when the library doesn't surface it — defaults to 0).
//
// Route registered:
//   GET /clusters?algorithm=louvain&seed=N&minSize=M
//
// no-console-log: this module emits no diagnostics. The wrapper in router.ts
// catches throws and maps to the {success:false,error} envelope.

import type { GraphKMStore } from '../../store/GraphKMStore.js';
import { clusterEntities } from '../../intelligence/clustering.js';
import type { RouteDescriptor } from '../router.js';

interface GraphLike {
  order: number;
}

/**
 * OKM-fixture-lock RNG seed for the Louvain partition. Matches the seed used
 * by OKM rest-contract.test.ts:63 (`mulberry32(0x43_06_5E_ED)`); caller can
 * override via `?seed=<int>` on the request.
 */
const DEFAULT_LOUVAIN_SEED = 0x43_06_5E_ED;

export function clusterRoutes(store: GraphKMStore): RouteDescriptor[] {
  return [
    {
      method: 'get',
      path: '/clusters',
      handler: async (req, res) => {
        const algorithm = ((req.query?.algorithm as string | undefined) ?? 'louvain') as
          | 'louvain';
        const rawSeed = req.query?.seed as string | undefined;
        const rawMinSize = req.query?.minSize as string | undefined;
        const callerSeed = rawSeed !== undefined ? parseInt(rawSeed, 10) : NaN;
        const seed = Number.isFinite(callerSeed) ? callerSeed : DEFAULT_LOUVAIN_SEED;
        const minSize =
          rawMinSize !== undefined ? Math.max(1, parseInt(rawMinSize, 10) || 1) : 1;
        const graph = (store as unknown as { graph: GraphLike }).graph;
        // Empty graph: emit the wire envelope shape with zero counts (NOT [],
        // so callers see the same shape regardless of graph state).
        if (graph.order === 0) {
          res.json({
            success: true,
            data: { clusters: [], count: 0, modularity: 0 },
          });
          return;
        }
        const result = clusterEntities(graph as never, {
          algorithm,
          seed,
          minSize,
        });
        // Project intelligence/clustering Cluster[] onto the OKM wire shape:
        //   {id: int, nodeIds: string[], size: int}
        // `id` is a sequential index; `nodeIds` = members; `size` = size.
        const wireClusters = result.clusters.map((c, idx) => ({
          id: idx,
          nodeIds: c.members,
          size: c.size,
        }));
        res.json({
          success: true,
          data: {
            clusters: wireClusters,
            count: wireClusters.length,
            modularity: result.modularity ?? 0,
          },
        });
      },
    },
  ];
}

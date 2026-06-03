// Phase 44 Plan 06: Louvain clustering handler for the canonical /api/v1 surface.
//
// SOURCE:
//   - 44-CONTEXT.md §C-3 — `/api/v1/clusters` uses a Louvain implementation
//     LIFTED INTO km-core (RESEARCH §Open Q3). km-core MUST NOT depend on OKM.
//   - 44-PATTERNS.md §clusters.ts — directs import to `intelligence/clustering`.
//   - 44-PATTERNS.md §Shared Patterns — `{success:true,data}` envelope.
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
        const seed = rawSeed !== undefined ? parseInt(rawSeed, 10) : undefined;
        const minSize =
          rawMinSize !== undefined ? Math.max(1, parseInt(rawMinSize, 10) || 1) : 1;
        const graph = (store as unknown as { graph: GraphLike }).graph;
        // Empty graph: return [] without running Louvain. clusterEntities also
        // handles this internally, but explicit short-circuit avoids any
        // surprise from the underlying library on a 0-node graph.
        if (graph.order === 0) {
          res.json({ success: true, data: [] });
          return;
        }
        const clusters = clusterEntities(graph as never, {
          algorithm,
          seed: Number.isFinite(seed) ? seed : undefined,
          minSize,
        });
        res.json({ success: true, data: clusters });
      },
    },
  ];
}

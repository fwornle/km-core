// Phase 44 Plan 06: query / export / stats / graph-inspection handlers for the
// canonical /api/v1 surface.
//
// SOURCE:
//   - 44-RESEARCH.md §Example 2 — OKM `routes.ts:462` (queryGraph), `:465`
//     (exportGraph), `:466` (getStats), `:477` (connectivity), `:478` (orphans).
//   - 44-PATTERNS.md §Shared Patterns — `{success:true,data}` envelope.
//
// Routes registered:
//   POST /query                — entity search/filter
//   GET  /export               — full graph dump
//   GET  /stats                — counts and domain summary
//   GET  /graph/connectivity   — connected component summary
//   GET  /graph/orphans        — entities with zero edges
//
// no-console-log: this module emits no diagnostics.

import type { GraphKMStore } from '../../store/GraphKMStore.js';
import type { Entity, Relation } from '../../types/entity.js';
import type { RouteDescriptor, KmCoreRouterOptions } from '../router.js';

interface GraphLike {
  order: number;
  size: number;
  nodes(): string[];
  edges(): string[];
  forEachNode(cb: (id: string, attrs: Entity) => void): void;
  forEachEdge(
    cb: (key: string, attrs: Relation, source: string, target: string) => void,
  ): void;
  degree(id: string): number;
  export(): { nodes: Array<{ key: string; attributes: Entity }>; edges: Array<{ key: string; source: string; target: string; attributes: Relation }> };
  neighbors(id: string): string[];
}

function getGraph(store: GraphKMStore): GraphLike {
  return (store as unknown as { graph: GraphLike }).graph;
}

export function queryRoutes(
  store: GraphKMStore,
  opts: KmCoreRouterOptions = {},
): RouteDescriptor[] {
  const routes: RouteDescriptor[] = [];

  // POST /query — apply ontologyClass + simple filters + paginate.
  routes.push({
    method: 'post',
    path: '/query',
    handler: async (req, res) => {
      const body = req.body ?? {};
      const cls = body.ontologyClass as string | undefined;
      const filters = (body.filters ?? {}) as Record<string, unknown>;
      const limit = typeof body.limit === 'number' ? body.limit : 0;
      const offset = typeof body.offset === 'number' ? body.offset : 0;

      let candidates: Entity[] = [];
      if (cls) {
        candidates = await store.findByOntologyClass(cls);
      } else {
        for await (const e of store.iterate()) {
          candidates.push(e);
        }
      }

      // Apply field-equality filters (simple shape used by OKM /query).
      for (const [field, expected] of Object.entries(filters)) {
        candidates = candidates.filter(
          (e) => (e as unknown as Record<string, unknown>)[field] === expected,
        );
      }

      const sliced =
        limit > 0 ? candidates.slice(offset, offset + limit) : candidates.slice(offset);

      res.json({ success: true, data: sliced });
    },
  });

  // GET /export — full graph dump.
  routes.push({
    method: 'get',
    path: '/export',
    handler: async (_req, res) => {
      const graph = getGraph(store);
      const exported = graph.export();
      res.json({
        success: true,
        data: {
          entities: exported.nodes.map((n) => n.attributes),
          relations: exported.edges.map((e) => ({
            key: e.key,
            from: e.source,
            to: e.target,
            relationType: e.attributes.type,
            createdAt: e.attributes.createdAt,
            metadata: e.attributes.metadata,
          })),
        },
      });
    },
  });

  // GET /stats — counts + domain summary.
  routes.push({
    method: 'get',
    path: '/stats',
    handler: async (_req, res) => {
      const graph = getGraph(store);
      const registry = opts.ontologyRegistry ?? store.ontology;
      const ontologyClasses = registry
        ? (registry as unknown as { classCatalog?: ReadonlyMap<string, unknown> }).classCatalog
            ?.size ?? 0
        : 0;
      const domainsRaw = registry
        ? (registry as unknown as { domains?: ReadonlySet<string> }).domains ?? new Set<string>()
        : new Set<string>();
      const domainsActive: string[] = Array.from(domainsRaw);
      res.json({
        success: true,
        data: {
          entityCount: graph.order,
          relationCount: graph.size,
          ontologyClasses,
          domainsActive,
        },
      });
    },
  });

  // GET /graph/connectivity — coarse component summary (count + largest size).
  routes.push({
    method: 'get',
    path: '/graph/connectivity',
    handler: async (_req, res) => {
      const graph = getGraph(store);
      const visited = new Set<string>();
      const components: number[] = [];
      for (const node of graph.nodes()) {
        if (visited.has(node)) continue;
        // BFS over undirected neighborhood.
        const queue: string[] = [node];
        visited.add(node);
        let size = 0;
        while (queue.length) {
          const cur = queue.shift()!;
          size += 1;
          for (const n of graph.neighbors(cur)) {
            if (!visited.has(n)) {
              visited.add(n);
              queue.push(n);
            }
          }
        }
        components.push(size);
      }
      components.sort((a, b) => b - a);
      res.json({
        success: true,
        data: {
          componentCount: components.length,
          largestComponentSize: components[0] ?? 0,
          components,
        },
      });
    },
  });

  // GET /graph/orphans — entities with zero edges.
  routes.push({
    method: 'get',
    path: '/graph/orphans',
    handler: async (_req, res) => {
      const graph = getGraph(store);
      const orphans: Entity[] = [];
      graph.forEachNode((id, attrs) => {
        if (graph.degree(id) === 0) {
          orphans.push(attrs);
        }
      });
      res.json({ success: true, data: orphans });
    },
  });

  return routes;
}

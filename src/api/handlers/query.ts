// Phase 44 Plan 06: query / export / stats / search / graph-inspection handlers
// for the canonical /api/v1 surface.
//
// SOURCE:
//   - 44-RESEARCH.md §Example 2 — OKM `routes.ts:462` (queryGraph), `:465`
//     (exportGraph), `:466` (getStats), `:477` (connectivity), `:478` (orphans).
//   - 44-PATTERNS.md §Shared Patterns — `{success:true,data}` envelope.
//
// 2026-06-03 amendment (44-CONTEXT-amendment.md): /stats, /export, /search,
// and /graph/connectivity emit the OKM wire shape. /query returns wire-shape
// entities. Adapter functions (`entityToWire`, `relationToWire`, `statsToWire`)
// project domain → wire per src/adapters/wire-serializers.ts.
//
// Routes registered:
//   POST /query                — entity search/filter (returns EntityWire[])
//   GET  /search               — full-text search over name/description (44-amend)
//   GET  /export               — graphology dump (ExportEndpointResponse)
//   GET  /stats                — counts + summary (StatsWire)
//   GET  /graph/connectivity   — GraphConnectivityEndpointResponse
//   GET  /graph/orphans        — entities with zero edges
//
// no-console-log: this module emits no diagnostics.

import type { GraphKMStore } from '../../store/GraphKMStore.js';
import type { Entity, Relation } from '../../types/entity.js';
import type { EntityId } from '../../ids/branded.js';
import type { RouteDescriptor, KmCoreRouterOptions } from '../router.js';
import {
  entityToWire,
  relationToWire,
  statsToWire,
} from '../../adapters/wire-serializers.js';

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
  export(): {
    attributes?: Record<string, unknown>;
    options?: { type: string; multi: boolean; allowSelfLoops: boolean };
    nodes: Array<{ key: string; attributes: Entity }>;
    edges: Array<{
      key: string;
      source: string;
      target: string;
      attributes: Relation;
      undirected?: boolean;
    }>;
  };
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

      // 44-CONTEXT-amendment.md: wire shape on the response.
      res.json({ success: true, data: sliced.map((e) => entityToWire(e)) });
    },
  });

  // GET /search?q=<text>&limit=<n> — substring search over name/description.
  //
  // Wire shape per OKM rest-contract.test.ts:142-156 (SearchEndpointResponse):
  //   { results: [{nodeId, name, entityType, layer, score, description}],
  //     total }
  //
  // Graceful baseline: simple substring + scoring (name match > description
  // match > metadata bag JSON match). Deeper semantic search can layer on
  // later; the wire SHAPE is the lock here.
  routes.push({
    method: 'get',
    path: '/search',
    handler: async (req, res) => {
      const q = (req.query?.q as string | undefined) ?? '';
      const rawLimit = req.query?.limit as string | undefined;
      const limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 20;
      const lowerQ = q.toLowerCase();
      if (!q) {
        res.json({ success: true, data: { results: [], total: 0 } });
        return;
      }
      const hits: Array<{
        nodeId: string;
        name: string;
        entityType: string;
        layer: string;
        score: number;
        description: string;
      }> = [];
      for await (const e of store.iterate()) {
        let score = 0;
        if (e.name?.toLowerCase().includes(lowerQ)) score += 3;
        if (e.description?.toLowerCase().includes(lowerQ)) score += 2;
        if (JSON.stringify(e.metadata ?? {}).toLowerCase().includes(lowerQ)) score += 1;
        if (score > 0) {
          hits.push({
            nodeId: `${e.layer}:${e.id}`,
            name: e.name,
            entityType: e.entityType,
            layer: e.layer,
            score,
            description: e.description ?? '',
          });
        }
      }
      hits.sort((a, b) => b.score - a.score);
      const limited =
        Number.isFinite(limit) && limit > 0 ? hits.slice(0, limit) : hits;
      res.json({
        success: true,
        data: { results: limited, total: limited.length },
      });
    },
  });

  // GET /export — graphology dump wrapped in the OKM ExportEndpointResponse shape.
  routes.push({
    method: 'get',
    path: '/export',
    handler: async (_req, res) => {
      const graph = getGraph(store);
      const exported = graph.export();
      // 44-CONTEXT-amendment.md: emit the OKM ExportEndpointResponse wire shape:
      //   { options: {type, multi, allowSelfLoops},
      //     attributes: {…},
      //     nodes: [{key, attributes: EntityWire}],
      //     edges: [{key, source, target, attributes: {type, metadata, createdAt}}] }
      const wireNodes = exported.nodes.map((n) => ({
        key: n.key,
        attributes: entityToWire(n.attributes),
      }));
      const wireEdges = exported.edges.map((e) => {
        // 44-09 Drift #2 fix: graphology's export() puts source/target at the
        // TOP LEVEL of each edge object — NOT inside e.attributes. Without
        // propagating them via `from`/`to`, relationToWire receives undefined
        // endpoints and emits empty-string source/target on the wire.
        const w = relationToWire({
          ...e.attributes,
          from: e.source as EntityId,
          to: e.target as EntityId,
          key: e.key,
        });
        const out: {
          key: string;
          source: string;
          target: string;
          attributes: { type: string; metadata: Record<string, unknown>; createdAt: string };
          undirected?: boolean;
        } = {
          key: w.key,
          source: w.source,
          target: w.target,
          attributes: w.attributes,
        };
        if (e.undirected !== undefined) out.undirected = e.undirected;
        return out;
      });
      res.json({
        success: true,
        data: {
          options: exported.options ?? {
            type: 'directed',
            multi: true,
            allowSelfLoops: false,
          },
          attributes: exported.attributes ?? {},
          nodes: wireNodes,
          edges: wireEdges,
        },
      });
    },
  });

  // GET /stats — counts + connectivity summary in OKM StatsWire shape.
  //
  // 44-CONTEXT-amendment.md: emit the 10-field StatsWire (nodes, edges,
  // evidenceCount, patternCount, orphanCount, islandCount, componentCount,
  // connectivity, lastUpdated, activeSnapshot:null).
  routes.push({
    method: 'get',
    path: '/stats',
    handler: async (_req, res) => {
      const graph = getGraph(store);

      // Count layers + orphans via a single pass; component count via BFS.
      let evidenceCount = 0;
      let patternCount = 0;
      let orphanCount = 0;
      const allNodes: string[] = [];
      graph.forEachNode((id, attrs) => {
        allNodes.push(id);
        if (attrs.layer === 'evidence') evidenceCount += 1;
        else if (attrs.layer === 'pattern') patternCount += 1;
        if (graph.degree(id) === 0) orphanCount += 1;
      });

      // Components via undirected BFS.
      const visited = new Set<string>();
      const componentSizes: number[] = [];
      for (const node of allNodes) {
        if (visited.has(node)) continue;
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
        componentSizes.push(size);
      }
      const componentCount = componentSizes.length;
      // Connectivity ≈ size of largest component / total nodes (OKM convention).
      const largest = componentSizes.reduce((a, b) => (b > a ? b : a), 0);
      const connectivity = graph.order > 0 ? largest / graph.order : 0;
      // Island count = number of non-trivial components beyond the largest
      // (OKM defines islands as small disconnected subgraphs).
      const islandCount = componentSizes.filter(
        (s) => s > 1 && s < largest,
      ).length;

      const wire = statsToWire({
        nodes: graph.order,
        edges: graph.size,
        evidenceCount,
        patternCount,
        orphanCount,
        islandCount,
        componentCount,
        connectivity,
        lastUpdated: new Date().toISOString(),
        activeSnapshot: null,
      });
      // Reference opts to keep signature honest (registry-aware stats may
      // surface here in a future revision — currently the wire shape does
      // not carry ontologyClass counts).
      void opts;
      res.json({ success: true, data: wire });
    },
  });

  // GET /graph/connectivity — wire shape per OKM rest-contract.test.ts:269-287.
  routes.push({
    method: 'get',
    path: '/graph/connectivity',
    handler: async (_req, res) => {
      const graph = getGraph(store);

      // Single pass: collect node attrs + degrees, identify orphans.
      const nodeAttrs = new Map<
        string,
        { name: string; entityType: string; layer: string; degree: number }
      >();
      graph.forEachNode((id, attrs) => {
        nodeAttrs.set(id, {
          name: attrs.name,
          entityType: attrs.entityType,
          layer: attrs.layer,
          degree: graph.degree(id),
        });
      });

      const trueOrphans: Array<{
        nodeId: string;
        name: string;
        entityType: string;
        layer: string;
        degree: number;
      }> = [];
      for (const [id, a] of nodeAttrs.entries()) {
        if (a.degree === 0) {
          trueOrphans.push({
            nodeId: id,
            name: a.name,
            entityType: a.entityType,
            layer: a.layer,
            degree: 0,
          });
        }
      }

      // Component BFS for component count + connectivity ratio.
      const visited = new Set<string>();
      const componentSizes: number[] = [];
      for (const node of nodeAttrs.keys()) {
        if (visited.has(node)) continue;
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
        componentSizes.push(size);
      }
      const componentCount = componentSizes.length;
      const largest = componentSizes.reduce((a, b) => (b > a ? b : a), 0);
      const connectivity = graph.order > 0 ? largest / graph.order : 0;

      res.json({
        success: true,
        data: {
          totalNodes: graph.order,
          totalEdges: graph.size,
          componentCount,
          connectivity,
          trueOrphans,
          islandNodes: [] as unknown[],
          components: [] as unknown[],
        },
      });
    },
  });

  // GET /graph/orphans — entities with zero edges (wire-shape entities).
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
      res.json({
        success: true,
        data: orphans.map((e) => entityToWire(e)),
      });
    },
  });

  return routes;
}

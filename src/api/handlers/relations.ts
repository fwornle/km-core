// Phase 44 Plan 06: relation CRUD handlers for the canonical /api/v1 surface.
//
// SOURCE:
//   - 44-RESEARCH.md §Example 2 — OKM `routes.ts:457-459` (createRelation,
//     listRelations, deleteRelation).
//   - 44-PATTERNS.md §Shared Patterns — `{success:true,data}` envelope.
//   - GraphKMStore.ts:583 (addRelation), :609 (findRelations), :728 (batch with
//     removeRelation op) — the underlying store surface.
//
// 2026-06-03 amendment (44-CONTEXT-amendment.md): the wire shape is the OKM
// graphology edge envelope `{key, source, target, attributes:{type, metadata,
// createdAt}}` — projected by `relationToWire` from the in-process Relation.
//
// no-console-log: this module emits no diagnostics. Error wrapper in router.ts
// catches thrown errors and maps to {success:false,error}.

import type { GraphKMStore } from '../../store/GraphKMStore.js';
import type { Relation } from '../../types/entity.js';
import type { EntityId } from '../../ids/branded.js';
import type { RouteDescriptor, KmCoreRouterOptions } from '../router.js';
import { relationToWire } from '../../adapters/wire-serializers.js';

export function relationRoutes(
  store: GraphKMStore,
  opts: KmCoreRouterOptions = {},
): RouteDescriptor[] {
  const readOnly = opts.readOnly === true;
  const routes: RouteDescriptor[] = [];

  // GET /relations — list with optional from/to/relationType filters.
  routes.push({
    method: 'get',
    path: '/relations',
    handler: async (req, res) => {
      const fromQ = req.query?.from as string | undefined;
      const toQ = req.query?.to as string | undefined;
      const typeQ = (req.query?.relationType ?? req.query?.type) as string | undefined;
      const filter: Partial<Relation> = {};
      if (fromQ) filter.from = fromQ as EntityId;
      if (toQ) filter.to = toQ as EntityId;
      if (typeQ) filter.type = typeQ;
      // withKey: the emitted `key` is what DELETE /relations/:key looks up.
      // Without it relationToWire synthesizes `<from>|<to>|<type>`, which only
      // matches edges that were added WITH that key — every edge created
      // through POST /relations gets a graphology `geid_…` id instead, so the
      // delete route 404'd on the majority of the graph while handing the
      // caller a key that looked entirely plausible.
      const relations = await store.findRelations(filter, { withKey: true });
      res.json({
        success: true,
        // 44-CONTEXT-amendment.md: emit graphology edge envelope per OKM
        // wire shape — relationToWire synthesizes deterministic key when absent.
        data: relations.map((r) => relationToWire(r)),
      });
    },
  });

  if (!readOnly) {
    // POST /relations — create.
    routes.push({
      method: 'post',
      path: '/relations',
      handler: async (req, res) => {
        const body = req.body ?? {};
        const relationType = body.relationType ?? body.type;
        if (!body.from || !body.to || !relationType) {
          res.status(400).json({
            success: false,
            error: 'from, to, and relationType are required',
          });
          return;
        }
        // Self-edge: a malformed request, not a server fault. `addRelation`
        // throws for every caller regardless — this exists so the REST surface
        // answers 400 rather than letting the store's throw surface as a 500,
        // which would read as "km-core broke" instead of "you sent a bad edge".
        if (body.from === body.to) {
          res.status(400).json({
            success: false,
            error: `Self-referential relation refused: '${String(relationType)}' from ${String(body.from)} to itself`,
          });
          return;
        }
        const relation: Relation = {
          from: body.from as EntityId,
          to: body.to as EntityId,
          type: relationType,
          metadata: body.metadata ?? {},
          createdAt: body.createdAt ?? new Date().toISOString(),
        };
        await store.addRelation(relation);
        res.status(201).json({
          success: true,
          data: relationToWire(relation),
        });
      },
    });

    // DELETE /relations/:key — remove by Graphology edge key.
    routes.push({
      method: 'delete',
      path: '/relations/:key',
      handler: async (req, res) => {
        const key = req.params?.key as string | undefined;
        if (!key) {
          res.status(400).json({ success: false, error: 'key is required' });
          return;
        }
        // Durability lives in the store: removeRelationByKey drops the edge,
        // emits relation:removed AND schedules the export. This route used to
        // cast through to `graph.dropEdge` itself and skip that last step, so
        // deletions were in-memory only and returned on the next restart.
        const removed = await store.removeRelationByKey(key);
        if (!removed) {
          res.status(404).json({ success: false, error: 'Relation not found' });
          return;
        }
        res.json({ success: true, data: { deleted: true, key } });
      },
    });
  }

  return routes;
}

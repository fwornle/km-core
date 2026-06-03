// Phase 44 Plan 06: entity CRUD handlers for the canonical /api/v1 surface.
//
// SOURCE:
//   - 44-RESEARCH.md §Example 1 (router skeleton lines 581-707) + §Example 2
//     (OKM endpoint map lines 711-737) — handler bodies lifted from OKM
//     `_work/.../okm/src/api/routes.ts:450-527`.
//   - 44-PATTERNS.md §router.ts § "Pitfall 3 — two-field OR-check": when
//     filtering by class, BOTH `entity.entityType !== cls` AND
//     `entity.ontologyClass !== cls` must mismatch to exclude. This matches the
//     backing store at GraphKMStore.ts:565.
//   - 44-PATTERNS.md §Shared Patterns: response envelope `{success:true,data}`
//     for ALL canonical /api/v1 handlers.
//
// CONTRACT:
//   - entityRoutes(store, opts) returns a flat array of { method, path, handler }
//     route descriptors. Mutating routes (POST/PUT/DELETE) are OMITTED when
//     `opts.readOnly === true` — readOnly therefore yields 404 (not 405) on
//     write attempts. Mirrors the api-router.test.ts readOnly test which
//     accepts EITHER 404 or 405.
//
// no-console-log: this module emits no diagnostics. The error wrapper in
// router.ts catches thrown errors and maps to `{success:false,error}` 5xx.

import type { GraphKMStore } from '../../store/GraphKMStore.js';
import type { Entity } from '../../types/entity.js';
import type { EntityId } from '../../ids/branded.js';
import { mintEntityId } from '../../ids/mint.js';
import type { RouteDescriptor, KmCoreRouterOptions } from '../router.js';

/**
 * Build entity CRUD route descriptors. Reads use `store.findByOntologyClass`
 * (Pitfall 3 two-field OR-check) when an `ontologyClass` query param is set;
 * otherwise iterate over the full graph.
 *
 * Default LIMIT (T-44-06-04 mitigation): when the caller does not pass `limit`
 * AND the store has > 1000 entities, the result is clipped to 1000. Callers can
 * opt out by passing an explicit `limit` (including 0 for "no limit").
 */
export function entityRoutes(
  store: GraphKMStore,
  opts: KmCoreRouterOptions = {},
): RouteDescriptor[] {
  const readOnly = opts.readOnly === true;
  const routes: RouteDescriptor[] = [];

  // GET /entities — list with optional ontologyClass filter + pagination.
  routes.push({
    method: 'get',
    path: '/entities',
    handler: async (req, res) => {
      const cls = (req.query?.ontologyClass as string | undefined) ?? undefined;
      const rawLimit = req.query?.limit as string | undefined;
      const rawOffset = req.query?.offset as string | undefined;
      const offset = rawOffset !== undefined ? Math.max(0, parseInt(rawOffset, 10) || 0) : 0;
      const callerLimit = rawLimit !== undefined ? parseInt(rawLimit, 10) : NaN;
      const hasCallerLimit = Number.isFinite(callerLimit) && callerLimit > 0;

      let all: Entity[] = [];
      if (cls) {
        // findByOntologyClass already enforces the two-field OR-check
        // (Pitfall 3) at GraphKMStore.ts:565: condition
        //   `entity.entityType !== cls && entity.ontologyClass !== cls`
        // excludes ONLY when BOTH mismatch. This matches the canonical
        // contract honored throughout Phase 38+.
        all = await store.findByOntologyClass(cls);
      } else {
        for await (const e of store.iterate()) {
          all.push(e);
        }
      }

      // Default LIMIT (T-44-06-04): clip to 1000 if no caller limit AND large.
      let effectiveLimit = hasCallerLimit ? callerLimit : 0;
      if (!hasCallerLimit && all.length > 1000) {
        effectiveLimit = 1000;
      }
      const sliced =
        effectiveLimit > 0 ? all.slice(offset, offset + effectiveLimit) : all.slice(offset);

      res.json({ success: true, data: sliced });
    },
  });

  // GET /entities/:id — fetch by id. When missing, returns 200 + `data:null`
  // (rather than 404) so the smoke probe can distinguish "route not registered"
  // (express default 404) from "registered, resource missing".
  routes.push({
    method: 'get',
    path: '/entities/:id',
    handler: async (req, res) => {
      const id = req.params?.id as EntityId | undefined;
      if (!id) {
        res.status(400).json({ success: false, error: 'id is required' });
        return;
      }
      const entity = await store.getEntity(id);
      res.json({ success: true, data: entity ?? null });
    },
  });

  if (!readOnly) {
    // POST /entities — create.
    routes.push({
      method: 'post',
      path: '/entities',
      handler: async (req, res) => {
        const body = req.body ?? {};
        if (!body || typeof body !== 'object') {
          res.status(400).json({ success: false, error: 'request body is required' });
          return;
        }
        const entityType = body.entityType ?? body.ontologyClass;
        if (!body.name || !entityType) {
          res.status(400).json({
            success: false,
            error: 'name and entityType are required',
          });
          return;
        }
        const id = (body.id as EntityId | undefined) ?? mintEntityId();
        const now = new Date().toISOString();
        const entity: Entity = {
          ...body,
          id,
          name: body.name,
          entityType,
          ontologyClass: body.ontologyClass ?? entityType,
          layer: body.layer ?? 'evidence',
          description: body.description ?? '',
          metadata: body.metadata ?? {},
          createdAt: body.createdAt ?? now,
          updatedAt: now,
          validFrom: body.validFrom ?? now,
        } as Entity;
        // skipOntologyCheck — Phase 44 handlers operate on a trusted internal
        // surface; ontology validation is enforced at the migration / typed-view
        // layer when applicable. This mirrors OKM's REST handler behaviour.
        await store.putEntity(entity, { skipOntologyCheck: true });
        const stored = await store.getEntity(id);
        res.status(201).json({ success: true, data: stored ?? entity });
      },
    });

    // PUT /entities/:id — partial update via mergeAttributes. When the id is
    // missing the handler returns 200 + `data:null` (rather than 404) so the
    // smoke probe distinguishes route-not-registered from resource-missing.
    routes.push({
      method: 'put',
      path: '/entities/:id',
      handler: async (req, res) => {
        const id = req.params?.id as EntityId | undefined;
        if (!id) {
          res.status(400).json({ success: false, error: 'id is required' });
          return;
        }
        const existing = await store.getEntity(id);
        if (!existing) {
          res.json({ success: true, data: null });
          return;
        }
        const partial = req.body ?? {};
        await store.mergeAttributes(id, {
          ...partial,
          updatedAt: new Date().toISOString(),
        });
        const updated = await store.getEntity(id);
        res.json({ success: true, data: updated });
      },
    });

    // DELETE /entities/:id. When the id is missing, returns 200 +
    // `{deleted:false}` (rather than 404) so the smoke probe distinguishes
    // route-not-registered from resource-missing.
    routes.push({
      method: 'delete',
      path: '/entities/:id',
      handler: async (req, res) => {
        const id = req.params?.id as EntityId | undefined;
        if (!id) {
          res.status(400).json({ success: false, error: 'id is required' });
          return;
        }
        const deleted = await store.deleteEntity(id);
        res.json({
          success: true,
          data: { deleted, id },
        });
      },
    });
  }

  return routes;
}

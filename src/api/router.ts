// Phase 44 Plan 06: keystone km-core deliverable — `createKmCoreRouter`.
//
// SOURCE:
//   - 44-CONTEXT.md §R-1 + §R-2 (revised): km-core does NOT `import express`.
//     The caller constructs `express.Router()` and passes it in; km-core
//     attaches handlers via `router.get/post/put/delete`. This keeps express as
//     a peerDependency/devDependency only.
//   - 44-RESEARCH.md §Pattern 1 (lines 149-200) — framework-agnostic factory.
//   - 44-RESEARCH.md §Example 1 (lines 581-707) — router skeleton.
//   - 44-RESEARCH.md §Example 2 (lines 711-737) — 15-endpoint map.
//   - 44-PATTERNS.md §router.ts § "Pattern deviations": rename to
//     createKmCoreRouter, mount path /api/v1/, snapshots shape, cluster Louvain,
//     `{success:true,data}` envelope unification.
//   - 44-PATTERNS.md §Error Handling Wrapper — try/catch per route; on throw
//     emit `{success:false,error:err.message}` (V7 control, never err.stack).
//
// Two public surfaces:
//   - createKMRoutes(store, opts): RouteDescriptor[] — returns route descriptors
//     (composition target for consumers who want to drive their own framework).
//   - createKmCoreRouter(store, router, opts): RouterLike — attaches all routes
//     to a caller-supplied Router-like object via the error-handling wrapper.
//
// no-console-log: this module uses `process.stderr.write` only on error paths
// (the error wrapper). No `console.*`. The wrapper does NOT leak err.stack
// (V7 / T-44-06-03 mitigation); only err.message is returned to the client.

import type { GraphKMStore } from '../store/GraphKMStore.js';
import type { OntologyRegistry } from '../ontology/registry.js';
import { entityRoutes } from './handlers/entities.js';
import { relationRoutes } from './handlers/relations.js';
import { queryRoutes } from './handlers/query.js';
import { ontologyRoutes } from './handlers/ontology.js';
import { clusterRoutes } from './handlers/clusters.js';
import { snapshotRoutes } from './handlers/snapshots.js';

// ----------------------------------------------------------------------------
// Public types
// ----------------------------------------------------------------------------

/**
 * Options for the createKmCoreRouter / createKMRoutes factories. All fields are
 * optional; the factory degrades gracefully when unconfigured.
 */
export interface KmCoreRouterOptions {
  /** Ontology registry powering /ontology/* endpoints. When omitted the
   *  factory falls back to `store.ontology` (the registry constructed at
   *  GraphKMStore-construction time via `ontologyDir`). */
  ontologyRegistry?: OntologyRegistry;
  /** Absolute path to the exports directory tracked under git — required to
   *  enable the /snapshots/* mutating routes (POST/restore). Without it only
   *  GET /snapshots is registered (and returns []). */
  snapshotDir?: string;
  /** When false, skip the snapshot router entirely (only GET /snapshots stays
   *  registered, returning []). Default true. */
  enableSnapshots?: boolean;
  /** When true, ALL mutating routes (POST/PUT/DELETE) are omitted from the
   *  attached router. Read routes (GET, plus POST /query which is a search,
   *  not a write) remain. Mirrors OKM's readOnly mount mode for the VOKB
   *  viewer's read-only consumers. */
  readOnly?: boolean;
  /** Optional human-readable restart command for the snapshot restore response
   *  envelope (CONTEXT S-2 revised). When omitted, restartCommand is null in
   *  the response and the operator/watchdog uses their system default. */
  restartCommand?: string;
  /** Phase 45 Plan 04: directory containing per-system display overlay files
   *  (`{ontologyDir}/{system}.display.json`). Consumed by the ontology handler
   *  ONLY when `?withDisplay=true` is requested. When omitted the enriched
   *  branch falls back to {} (no display block). Pre-Phase-45 BC path
   *  (no query param) is unaffected. */
  ontologyDir?: string;
  /** Phase 45 Plan 04: per-system overlay-file lookup name. Defaults to
   *  the ontology registry's first loaded non-upper domain (when omitted).
   *  Operators with a non-default naming convention can override here. */
  displayOverlaySystem?: string;
}

/**
 * Minimal Router-like interface the factory writes to. Matches the shape of
 * `express.Router()` for the four HTTP verbs used by the canonical surface.
 * Consumers may pass an actual express Router, a Fastify router (with a thin
 * adapter), or a test double.
 */
export interface RouterLike {
  get: (path: string, handler: (req: never, res: never) => unknown) => unknown;
  post: (path: string, handler: (req: never, res: never) => unknown) => unknown;
  put: (path: string, handler: (req: never, res: never) => unknown) => unknown;
  delete: (
    path: string,
    handler: (req: never, res: never) => unknown,
  ) => unknown;
}

/**
 * Route descriptor — the framework-agnostic representation used internally by
 * `createKMRoutes`. Consumers who want to drive their own framework attach to
 * `routes[*].handler` themselves; the convenience `createKmCoreRouter` does
 * this for them through the error-handling wrapper.
 */
export interface RouteDescriptor {
  method: 'get' | 'post' | 'put' | 'delete';
  path: string;
  // The handler is intentionally typed loosely so consumer-supplied req/res
  // types (express, fastify, etc.) all satisfy it. The wrapper in
  // createKmCoreRouter coerces back to the consumer's exact request/response
  // shape at registration time.
  handler: (req: any, res: any) => unknown | Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

// ----------------------------------------------------------------------------
// createKMRoutes — framework-agnostic route descriptor list
// ----------------------------------------------------------------------------

/**
 * Build the full list of 15 canonical /api/v1 route descriptors backed by the
 * supplied GraphKMStore.
 *
 * Routes (per 44-RESEARCH §Example 2):
 *   GET    /entities                       — list (Pitfall 3 OR-check filter)
 *   GET    /entities/:id                   — fetch by id
 *   POST   /entities                       — create (omitted when readOnly)
 *   PUT    /entities/:id                   — update (omitted when readOnly)
 *   DELETE /entities/:id                   — delete (omitted when readOnly)
 *   GET    /relations                      — list with from/to/relationType filter
 *   POST   /relations                      — create (omitted when readOnly)
 *   POST   /query                          — entity search/filter
 *   GET    /export                         — full graph dump
 *   GET    /stats                          — counts and domain summary
 *   GET    /graph/connectivity             — component summary
 *   GET    /graph/orphans                  — entities with zero edges
 *   GET    /ontology/classes               — list resolved ontology classes
 *   GET    /ontology/entity-types          — list distinct entityType strings
 *   GET    /ontology/schema/:className     — single class schema lookup
 *   GET    /clusters                       — Louvain communities
 *   GET    /snapshots                      — list (always registered)
 *   POST   /snapshots                      — create (omitted when readOnly OR snapshots disabled)
 *   POST   /snapshots/:id/restore          — restore (omitted when readOnly OR snapshots disabled)
 *
 * Plus DELETE /relations/:key when not readOnly.
 *
 * The "15 canonical endpoints" mantra refers to the SET of canonical paths the
 * Wave 0 api-router smoke test probes (see test fixture). This factory may
 * register MORE than 15 routes (e.g. when both read+write variants of an
 * endpoint exist) — the smoke just asserts each canonical path is wired.
 */
export function createKMRoutes(
  store: GraphKMStore,
  opts: KmCoreRouterOptions = {},
): RouteDescriptor[] {
  return [
    ...entityRoutes(store, opts),
    ...relationRoutes(store, opts),
    ...queryRoutes(store, opts),
    ...ontologyRoutes(store, opts),
    ...clusterRoutes(store),
    ...snapshotRoutes(store, opts),
  ];
}

// ----------------------------------------------------------------------------
// createKmCoreRouter — public surface (attaches routes to a RouterLike)
// ----------------------------------------------------------------------------

/**
 * Attach the 15 canonical /api/v1 route handlers to a caller-supplied
 * Router-like object. Each handler is wrapped in a try/catch that emits the
 * canonical `{success:false, error: <message>}` envelope on throw — stack
 * traces are NEVER returned (T-44-06-03 mitigation).
 *
 * Per 44-CONTEXT §R-2 (revised): km-core does NOT import express. The caller
 * constructs `const r = express.Router()` then calls
 * `createKmCoreRouter(store, r, opts)` and `app.use('/api/v1', r)`.
 *
 * Return value is the same router instance for fluent-chain ergonomics.
 */
export function createKmCoreRouter<R extends RouterLike>(
  store: GraphKMStore,
  router: R,
  opts: KmCoreRouterOptions = {},
): R {
  const routes = createKMRoutes(store, opts);
  for (const route of routes) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrappedHandler = async (req: any, res: any): Promise<void> => {
      try {
        await route.handler(req, res);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // V7 / T-44-06-03 — never leak err.stack to clients. Surface a
        // one-line diagnostic on stderr (the caller's logging is opaque to
        // km-core; stderr is the agreed convention per 44-PATTERNS §Shared
        // Patterns "Logging via process.stderr.write").
        process.stderr.write(
          `[km-core/api] ${route.method.toUpperCase()} ${route.path} -> ${message}\n`,
        );
        // Decide status: if the handler already sent headers, do nothing.
        if (!res.headersSent) {
          res.status(500).json({ success: false, error: message });
        }
      }
    };
    // RouterLike.get/post/put/delete are typed loosely above; cast to a
    // record-of-functions to keep the bracket access typesafe in TS.
    const verbs = router as unknown as Record<string, (path: string, handler: (req: never, res: never) => unknown) => unknown>;
    verbs[route.method](
      route.path,
      wrappedHandler as unknown as (req: never, res: never) => unknown,
    );
  }
  return router;
}

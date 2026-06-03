// Phase 44 Plan 06: snapshot/restore handlers for the canonical /api/v1 surface.
//
// SOURCE:
//   - 44-CONTEXT.md §S-2 (revised): handler wraps `SnapshotManager.restoreSnapshot`
//     result with `restartRequired: true` + `restartCommand`. Handler does NOT
//     call process.exit; the operator (or a watchdog) restarts the service.
//     RESEARCH §Pitfall 4 explains why an in-process restart is unsafe.
//   - 44-CONTEXT.md §S-1 + §S-4: POST /snapshots flushes pending exports then
//     calls SnapshotManager.createSnapshot(label). GET /snapshots enumerates
//     git tags via SnapshotManager.listSnapshots().
//   - 44-PATTERNS.md §Shared Patterns — `{success:true,data}` envelope.
//
// Routes registered:
//   POST   /snapshots                    — create (requires !readOnly)
//   GET    /snapshots                    — list (always present when enabled)
//   POST   /snapshots/:id/restore        — restore (requires confirmDestructive)
//
// Destructive-confirmation gate (T-44-06-01 mitigation): restore handler
// returns 400 unless body contains `confirmDestructive: true`. SnapshotManager
// also enforces this — two layers of defense.
//
// no-console-log: this module emits no diagnostics. SnapshotManager handles its
// own one-line stderr diagnostics on the empty-ls-tree path.

import type { GraphKMStore } from '../../store/GraphKMStore.js';
import { SnapshotManager } from '../../snapshots/SnapshotManager.js';
import type { RouteDescriptor, KmCoreRouterOptions } from '../router.js';

export function snapshotRoutes(
  store: GraphKMStore,
  opts: KmCoreRouterOptions = {},
): RouteDescriptor[] {
  const readOnly = opts.readOnly === true;
  const enableSnapshots = opts.enableSnapshots !== false;
  if (!enableSnapshots || !opts.snapshotDir) {
    // Always register at least GET /snapshots so the canonical 15-endpoint
    // smoke passes registration even when snapshots are unconfigured. The
    // handler returns an empty list.
    return [
      {
        method: 'get',
        path: '/snapshots',
        handler: async (_req, res) => {
          res.json({ success: true, data: [] });
        },
      },
    ];
  }

  const snapshotMgr = new SnapshotManager({ exportDir: opts.snapshotDir });
  const restartCommand = opts.restartCommand ?? null;
  const routes: RouteDescriptor[] = [];

  // GET /snapshots — always available when enabled.
  routes.push({
    method: 'get',
    path: '/snapshots',
    handler: async (_req, res) => {
      const list = await snapshotMgr.listSnapshots();
      res.json({ success: true, data: list });
    },
  });

  if (!readOnly) {
    // POST /snapshots — create.
    routes.push({
      method: 'post',
      path: '/snapshots',
      handler: async (req, res) => {
        const label = (req.body?.label ?? 'manual') as string;
        // Flush pending debounced exports first so the snapshot captures the
        // latest in-memory state. Matches the orphan-draft pattern at
        // dist/api/router.js:606.
        await store.exportJson();
        const entry = await snapshotMgr.createSnapshot(label);
        res.status(201).json({ success: true, data: entry });
      },
    });

    // POST /snapshots/:id/restore — destructive; requires confirmDestructive.
    routes.push({
      method: 'post',
      path: '/snapshots/:id/restore',
      handler: async (req, res) => {
        const id = req.params?.id as string | undefined;
        if (!id) {
          res
            .status(400)
            .json({ success: false, error: 'snapshot id is required' });
          return;
        }
        const confirmDestructive = req.body?.confirmDestructive === true;
        if (!confirmDestructive) {
          // T-44-06-01: handler-layer destructive gate. SnapshotManager would
          // also throw on missing confirmDestructive, but failing fast here
          // gives a cleaner 400 (rather than 500-wrapped manager throw).
          res.status(400).json({
            success: false,
            error:
              'confirmDestructive:true required in request body (restore is destructive — overwrites the exports directory).',
          });
          return;
        }
        const result = await snapshotMgr.restoreSnapshot(id, {
          confirmDestructive: true,
        });
        // S-2 revised: wrap with restartRequired so the operator (or watchdog)
        // can restart the service. Handler does NOT call process.exit.
        res.json({
          success: true,
          data: {
            ...result,
            restartRequired: true,
            restartCommand,
          },
        });
      },
    });
  }

  return routes;
}

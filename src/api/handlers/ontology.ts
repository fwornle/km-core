// Phase 44 Plan 06: ontology metadata handlers for the canonical /api/v1 surface.
//
// SOURCE:
//   - 44-RESEARCH.md §Example 2 — OKM `routes.ts:482-484` (getOntologyClasses,
//     getOntologyEntityTypes, getOntologySchema).
//   - 44-PATTERNS.md §Shared Patterns — `{success:true,data}` envelope.
//
// Routes registered:
//   GET /ontology/classes              — list resolved ontology classes
//   GET /ontology/entity-types         — list distinct entityType strings
//   GET /ontology/schema/:className    — single class schema lookup
//
// All routes are read-only; no `if (!readOnly)` gate needed.
//
// no-console-log: this module emits no diagnostics.

import type { GraphKMStore } from '../../store/GraphKMStore.js';
import type { OntologyRegistry } from '../../ontology/registry.js';
import type { RouteDescriptor, KmCoreRouterOptions } from '../router.js';

interface RegistryLike {
  classCatalog: ReadonlyMap<string, unknown>;
  domains: ReadonlySet<string>;
  isValidClass?(name: string): boolean;
}

function getRegistry(
  store: GraphKMStore,
  opts: KmCoreRouterOptions,
): RegistryLike | undefined {
  const r = (opts.ontologyRegistry ?? store.ontology) as unknown as
    | OntologyRegistry
    | undefined;
  return r as unknown as RegistryLike | undefined;
}

export function ontologyRoutes(
  store: GraphKMStore,
  opts: KmCoreRouterOptions = {},
): RouteDescriptor[] {
  const routes: RouteDescriptor[] = [];

  // GET /ontology/classes — list resolved ontology classes from the registry.
  routes.push({
    method: 'get',
    path: '/ontology/classes',
    handler: async (_req, res) => {
      const registry = getRegistry(store, opts);
      const classes = registry
        ? Array.from(registry.classCatalog.values())
        : [];
      res.json({ success: true, data: classes });
    },
  });

  // GET /ontology/entity-types — distinct entityType strings drawn from the
  // ontology registry (when present); otherwise an empty list. The endpoint
  // exists for shape parity with OKM — A's typed views and B's REST tests
  // expect a 200 + envelope, not a 404, when no registry is wired.
  routes.push({
    method: 'get',
    path: '/ontology/entity-types',
    handler: async (_req, res) => {
      const registry = getRegistry(store, opts);
      if (!registry) {
        res.json({ success: true, data: [] });
        return;
      }
      const types = new Set<string>();
      for (const [name] of registry.classCatalog.entries()) {
        types.add(name);
      }
      res.json({
        success: true,
        data: Array.from(types).sort(),
      });
    },
  });

  // GET /ontology/schema/:className — single class lookup.
  routes.push({
    method: 'get',
    path: '/ontology/schema/:className',
    handler: async (req, res) => {
      const className = req.params?.className as string | undefined;
      if (!className) {
        res.status(400).json({ success: false, error: 'className is required' });
        return;
      }
      const registry = getRegistry(store, opts);
      const cls = registry?.classCatalog.get(className);
      if (!cls) {
        res.status(404).json({ success: false, error: 'Class not found' });
        return;
      }
      res.json({ success: true, data: cls });
    },
  });

  return routes;
}

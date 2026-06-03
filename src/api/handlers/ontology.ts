// Phase 44 Plan 06: ontology metadata handlers for the canonical /api/v1 surface.
//
// SOURCE:
//   - 44-RESEARCH.md §Example 2 — OKM `routes.ts:482-484` (getOntologyClasses,
//     getOntologyEntityTypes, getOntologySchema).
//   - 44-PATTERNS.md §Shared Patterns — `{success:true,data}` envelope.
//
// 2026-06-03 amendment (44-CONTEXT-amendment.md):
//   - /api/ontology/classes returns an array of class-name STRINGS (OKM
//     rest-contract.test.ts:257). The previous shape (array of objects with
//     parent/properties/relationships) was a wrong-shape invention not in
//     OKM's frozen wire contract.
//   - /api/ontology/entity-types returns an array of {name, description,
//     source} objects (OKM rest-contract.test.ts:259-267).
//   - /api/ontology/schema/:className remains free-form (consumers read the
//     full ResolvedClass — not part of the byte-equal fixture lock).
//
// Routes registered:
//   GET /ontology/classes              — array of class name strings
//   GET /ontology/entity-types         — array of {name, description, source}
//   GET /ontology/schema/:className    — single class schema lookup
//
// All routes are read-only; no `if (!readOnly)` gate needed.
//
// no-console-log: this module emits no diagnostics.

import type { GraphKMStore } from '../../store/GraphKMStore.js';
import type { OntologyRegistry } from '../../ontology/registry.js';
import type { ResolvedClass } from '../../types/ontology.js';
import type { RouteDescriptor, KmCoreRouterOptions } from '../router.js';

interface RegistryLike {
  classCatalog: ReadonlyMap<string, ResolvedClass>;
  domains: ReadonlySet<string>;
  isValidClass?(name: string): boolean;
  getClass?(name: string): ResolvedClass | undefined;
  getAllClassNames?(): string[];
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

  // GET /ontology/classes — array of class NAME STRINGS (OKM wire shape:
  // rest-contract.test.ts:257 = `ApiSuccessEnvelope(z.array(z.string()))`).
  routes.push({
    method: 'get',
    path: '/ontology/classes',
    handler: async (_req, res) => {
      const registry = getRegistry(store, opts);
      const names = registry
        ? registry.getAllClassNames
          ? registry.getAllClassNames()
          : Array.from(registry.classCatalog.keys())
        : [];
      res.json({ success: true, data: names });
    },
  });

  // GET /ontology/entity-types — array of {name, description, source} (OKM
  // wire shape: rest-contract.test.ts:259-267). When no registry is wired,
  // returns []. Matches OKM's `getOntologyEntityTypes` at routes.ts:1345-1366.
  routes.push({
    method: 'get',
    path: '/ontology/entity-types',
    handler: async (_req, res) => {
      const registry = getRegistry(store, opts);
      if (!registry) {
        res.json({ success: true, data: [] });
        return;
      }
      const names = registry.getAllClassNames
        ? registry.getAllClassNames()
        : Array.from(registry.classCatalog.keys());
      const details = names.map((name) => {
        const cls = registry.getClass
          ? registry.getClass(name)
          : registry.classCatalog.get(name);
        return {
          name,
          description: (cls?.description ?? '') as string,
          source: (cls?.source ?? 'unknown') as string,
        };
      });
      res.json({ success: true, data: details });
    },
  });

  // GET /ontology/schema/:className — single class lookup. Returns the
  // ResolvedClass (free-form — not part of the byte-equal fixture lock).
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
      const cls = registry?.getClass
        ? registry.getClass(className)
        : registry?.classCatalog.get(className);
      if (!cls) {
        res.status(404).json({ success: false, error: 'Class not found' });
        return;
      }
      res.json({ success: true, data: cls });
    },
  });

  return routes;
}

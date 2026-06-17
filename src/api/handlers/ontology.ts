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
// 2026-06-07 Phase 45 Plan 04 extension (45-04-PLAN.md):
//   - GET /ontology/classes?withDisplay=true returns array of objects
//     {name, level?, parent?, display?} enriched by merging
//     .data/ontologies/{system}.display.json overlay per loadDisplayOverlay.
//   - When the param is ABSENT or any non-'true' value, response is
//     byte-identical to the pre-Phase-45 contract — z.array(z.string()) per
//     OKM rest-contract.test.ts:257. T-45-04-03 BC-regression mitigation.
//
// 2026-06-09 Phase 55 Plan 02 extension (55-02-PLAN.md, UI-SPEC §14):
//   - The DisplayHint interface imported from ../../ontology/display-overlay.js
//     now carries two additional optional fields:
//       borderStyle?: 'solid' | 'dashed'
//       pulseRule?: null | 'lastUpdatedWithin:60s' | 'lastUpdatedWithin:5m'
//         | 'recentlyMerged:1h'
//   - This handler is shape-agnostic — the spread `entry.display = hint`
//     forwards whatever optional fields the loader returns; the renderer
//     applies fallback rules (UI-SPEC §14: dashed for orphans, no pulse for
//     undefined).
//   - Strict-equal `"true"` BC gate at line ~141 stays unchanged; only the
//     DisplayHint shape widens. T-45-04-03 lock preserved verbatim.
//
// Routes registered:
//   GET /ontology/classes              — array of class name strings (BC)
//   GET /ontology/classes?withDisplay=true — enriched objects (45-04)
//   GET /ontology/entity-types         — array of {name, description, source}
//   GET /ontology/schema/:className    — single class schema lookup
//
// All routes are read-only; no `if (!readOnly)` gate needed.
//
// no-console-log: this module emits no diagnostics directly. Display-overlay
// loader writes to stderr on malformed JSON.

import type { GraphKMStore } from '../../store/GraphKMStore.js';
import type { OntologyRegistry } from '../../ontology/registry.js';
import type { ResolvedClass } from '../../types/ontology.js';
import type { RouteDescriptor, KmCoreRouterOptions } from '../router.js';
import { loadDisplayOverlay } from '../../ontology/display-overlay.js';
import type { DisplayHint } from '../../ontology/display-overlay.js';
// Phase 60.07 Task 2 — Path B (HIERARCHY_ROOTS synthesis). Internal import
// from the SAME km-core types module (NOT '@fwornle/km-core' — would create
// a self-referential dependency cycle during build). Plan 60-04 ships the
// closed-set vocabulary; we read both the tuple and the lookup map.
import { HIERARCHY_ROOTS, HIERARCHY_ROOT_CLASS } from '../../types/hierarchy-roots.js';
// Surface witness — touched here so strict tree-shakers cannot eliminate the
// import if only HIERARCHY_ROOT_CLASS is referenced by runtime code below.
void HIERARCHY_ROOTS;

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

/**
 * Resolve the ontologyDir for the display-overlay lookup. Precedence:
 *   1. opts.ontologyDir (caller-supplied at router construction)
 *   2. req.app?.locals?.ontologyDir (Express convention — set by host-side
 *      bootstrap; see 45-04-PLAN.md task action)
 *
 * Returns undefined when neither path supplies a value — the handler then
 * skips the overlay merge (returns enriched shape with no display blocks).
 * NEVER reads process.env per CLAUDE.md no-env-var-fallback discipline.
 */
function resolveOntologyDir(
  req: unknown,
  opts: KmCoreRouterOptions,
): string | undefined {
  if (opts.ontologyDir && opts.ontologyDir.length > 0) return opts.ontologyDir;
  const r = req as { app?: { locals?: { ontologyDir?: unknown } } };
  const fromLocals = r.app?.locals?.ontologyDir;
  if (typeof fromLocals === 'string' && fromLocals.length > 0) return fromLocals;
  return undefined;
}

/**
 * Resolve the overlay-file system name. Precedence:
 *   1. opts.displayOverlaySystem (caller-supplied)
 *   2. req.app?.locals?.displayOverlaySystem
 *   3. The first non-'upper' loaded ontology domain (registry.domains)
 *
 * Returns undefined when no candidate is found — handler skips overlay merge.
 */
function resolveOverlaySystem(
  req: unknown,
  opts: KmCoreRouterOptions,
  registry: RegistryLike | undefined,
): string | undefined {
  if (opts.displayOverlaySystem && opts.displayOverlaySystem.length > 0) {
    return opts.displayOverlaySystem;
  }
  const r = req as { app?: { locals?: { displayOverlaySystem?: unknown } } };
  const fromLocals = r.app?.locals?.displayOverlaySystem;
  if (typeof fromLocals === 'string' && fromLocals.length > 0) return fromLocals;
  if (registry?.domains) {
    for (const d of registry.domains) {
      if (d !== 'upper') return d;
    }
  }
  return undefined;
}

export function ontologyRoutes(
  store: GraphKMStore,
  opts: KmCoreRouterOptions = {},
): RouteDescriptor[] {
  const routes: RouteDescriptor[] = [];

  // GET /ontology/classes — array of class NAME STRINGS (OKM wire shape:
  // rest-contract.test.ts:257 = `ApiSuccessEnvelope(z.array(z.string()))`).
  //
  // Phase 45 Plan 04 extension: when ?withDisplay=true, returns enriched
  // objects {name, level?, parent?, display?} with the display block sourced
  // from .data/ontologies/{system}.display.json via loadDisplayOverlay.
  // ABSENT param OR any non-'true' value -> BC string-array shape (T-45-04-03).
  routes.push({
    method: 'get',
    path: '/ontology/classes',
    handler: async (req, res) => {
      const registry = getRegistry(store, opts);
      const names = registry
        ? registry.getAllClassNames
          ? registry.getAllClassNames()
          : Array.from(registry.classCatalog.keys())
        : [];

      // BC GATE — strict-equal check on 'true' (Pitfall T-45-04-03 mitigation).
      // ?withDisplay=foo, ?withDisplay=1, ?withDisplay absent → BC string-array.
      // ?withDisplay=true&withDisplay=true (duplicate) — Express returns an
      // array; we check the first element. Object-form (?withDisplay[]=true)
      // would be {0:'true'} — string-equality below fails safely (returns BC).
      const rawParam = req.query?.withDisplay;
      const withDisplayParam = Array.isArray(rawParam) ? rawParam[0] : rawParam;
      const wantsDisplay = withDisplayParam === 'true';

      if (!wantsDisplay) {
        // BC PATH — byte-identical to pre-Phase-45 contract.
        res.json({ success: true, data: names });
        return;
      }

      // ENRICHED PATH — Phase 45 Plan 04. Per the plan's interfaces block:
      //   data: Array<{name, level?, parent?, display?}>
      // The display field is `undefined` when no overlay entry exists for the
      // class — Plan Test 3 requires undefined (not null, not missing-key).
      // We achieve this by deleting the property when overlay[name] is absent
      // so JSON serialization omits it (matching `undefined` for consumers).
      let overlay: Record<string, DisplayHint> = {};
      const ontologyDir = resolveOntologyDir(req, opts);
      const overlaySystem = resolveOverlaySystem(req, opts, registry);
      if (ontologyDir && overlaySystem) {
        try {
          overlay = loadDisplayOverlay(ontologyDir, overlaySystem);
        } catch (err: unknown) {
          // ontologyDir invariant violation — surface to stderr but degrade
          // gracefully (empty overlay) so the endpoint still returns enriched
          // shape with no display blocks rather than 500-ing the whole route.
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[km-core/ontology] loadDisplayOverlay failed: ${msg}\n`,
          );
          overlay = {};
        }
      }

      const enriched = names.map((name) => {
        const cls = registry?.getClass
          ? registry.getClass(name)
          : registry?.classCatalog.get(name);
        const entry: {
          name: string;
          level?: number;
          parent?: string;
          display?: DisplayHint;
        } = { name };
        // ResolvedClass carries `defaultLayer` (evidence/pattern) — not a
        // numeric level. Phase 45 viewer reads `level` (number) for the L0-L3
        // filter; we expose `level` ONLY when downstream ontology metadata
        // surfaces it (lower files MAY include `level`/`parent` per
        // 45-UI-SPEC § Color "level, parent" hints). Cast-through to read
        // unknown extra fields without losing strict types upstream.
        const extra = cls as unknown as
          | { level?: number; parent?: string }
          | undefined;
        if (extra && typeof extra.level === 'number') entry.level = extra.level;
        if (extra && typeof extra.parent === 'string') entry.parent = extra.parent;
        // Phase 60.07 D-3 — parent fallback from `extends`. When an L2 class
        // ships `extends: <X>` but omits explicit `parent`, derive parent
        // from extends so the viewer's L1→L2 group construction
        // (OntologyFilter.tsx:457 `c.level === 2 && c.parent`) can match
        // without requiring data-side duplication. Explicit `parent` always
        // wins (Test 4 — `entry.parent !== undefined` after the line above
        // short-circuits this fallback).
        if (entry.parent === undefined && cls && typeof cls.extends === 'string') {
          entry.parent = cls.extends;
        }
        const hint = overlay[name];
        if (hint) entry.display = hint;
        return entry;
      });

      // Phase 60.07 D-23 — Path B HIERARCHY_ROOTS synthesis for the coding
      // system. The closed-set hierarchy roots (CollectiveKnowledge + 4
      // project anchors) map to L0 anchor classes (System | Project) via
      // HIERARCHY_ROOT_CLASS. The viewer's OntologyFilter renders L0 rows
      // ungrouped at the top of the section — but only the anchor CLASS
      // names need to appear in the registry response (not the individual
      // root entity names). So we synthesize one entry per UNIQUE lockedClass
      // value in HIERARCHY_ROOT_CLASS — typically {System, Project} — that
      // is not already present in the enriched array (idempotency, Test 2).
      //
      // Synthesis is scoped to the configured coding system: if the host
      // wired `displayOverlaySystem: 'coding'` (the standard obs-api bootstrap
      // at scripts/observations-api-server.mjs:1396), we synthesize. For any
      // other system identity (e.g. 'okb'), we skip — keeps Phase 60.04's
      // single-source-of-truth scope from leaking into unrelated tabs.
      if (overlaySystem === 'coding') {
        const presentNames = new Set(enriched.map((e) => e.name));
        const seenLockedClasses = new Set<'System' | 'Project'>();
        const synthesized: Array<{
          name: string;
          level: number;
        }> = [];
        for (const root of HIERARCHY_ROOTS) {
          const lockedClass = HIERARCHY_ROOT_CLASS[root];
          if (seenLockedClasses.has(lockedClass)) continue;
          seenLockedClasses.add(lockedClass);
          if (presentNames.has(lockedClass)) continue;
          synthesized.push({ name: lockedClass, level: 0 });
        }
        // Prepend so L0 anchors appear at the top of the array — the viewer's
        // group construction also re-sorts but prepending is the friendlier
        // default for any consumer that walks the array in wire order.
        if (synthesized.length > 0) {
          enriched.unshift(...synthesized);
        }
      }

      res.json({ success: true, data: enriched });
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

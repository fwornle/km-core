// Phase 60 D-14 + D-23 — Hierarchy roots registry: closed-set of entity
// names whose `ontologyClass` is hard-locked at the writer + LLM-classifier
// boundary. The re-classifier MUST exempt these names regardless of LLM
// verdict; repair scripts use this list as the source of truth when
// restoring drifted classifications.
//
// SINGLE SOURCE OF TRUTH for the hierarchy roots. Importers:
//   - integrations/mcp-server-semantic-analysis/src/agents/
//     ontology-classification-agent.ts (writer-side guard, D-14)
//   - scripts/repair-ck-ontology-class.mjs (one-shot data repair, D-13)
//
// Pattern source: integrations/mcp-server-semantic-analysis/src/agents/
// quality-assurance-agent.ts:1921 (`exemptNodes` Set). Narrowed from QA's
// 8-element set to the 5 Phase-60-scoped roots per D-14:
//   - CollectiveKnowledge (System root for VKB knowledge graph)
//   - Coding, DynArch, Timeline, Normalisa (the 4 project anchors)
//
// Excluded: Ui, Resi, Raas — Phase 57 deferred team-anchor work
// (see Phase 60 CONTEXT.md <deferred> section). Add when LOWERONTO-04 lands.
//
// Adding a new hierarchy root is a code change in this file:
//   1. Append the new literal to the `HIERARCHY_ROOTS` tuple (preserve
//      order — consumers may depend on positional indexing).
//   2. Add the corresponding entry to `HIERARCHY_ROOT_CLASS`.
//   3. Update `tests/unit/hierarchy-roots.test.ts` to lock the new
//      vocabulary.
//   4. Update any consumer that hardcodes the hierarchy root list.
//
// Pattern: combines the closed-set `as const` array + derived literal-union
// + runtime typeguard pattern. Mirrors the `Project` literal-union convention
// in `src/types/project.ts` (Phase 57 D-03).

/**
 * Closed-set hierarchy-root vocabulary (Phase 60 D-14 + D-23).
 * Order is load-bearing.
 */
export const HIERARCHY_ROOTS = [
  'CollectiveKnowledge',
  'Coding',
  'DynArch',
  'Timeline',
  'Normalisa',
] as const;

/** Derived literal-union type for compile-time `HierarchyRoot` typing. */
export type HierarchyRoot = typeof HIERARCHY_ROOTS[number];

/**
 * Locked `ontologyClass` for each hierarchy root.
 *
 * The 5 roots split into:
 *   - 1 System root: `CollectiveKnowledge`
 *   - 4 Project anchors: `Coding`, `DynArch`, `Timeline`, `Normalisa`
 *
 * Both classes are upper-ontology classes (declared in
 * `.data/ontologies/upper.json`). Phase 60 D-13 / D-14 do not introduce
 * any new class names — they pin existing classes to existing names.
 */
export const HIERARCHY_ROOT_CLASS: Record<HierarchyRoot, 'System' | 'Project'> = {
  CollectiveKnowledge: 'System',
  Coding: 'Project',
  DynArch: 'Project',
  Timeline: 'Project',
  Normalisa: 'Project',
};

/**
 * Runtime typeguard for the writer-side guard + repair-script lookups.
 *
 * Returns `true` iff `name` is a string equal to one of the
 * {@link HIERARCHY_ROOTS} tuple members (case-sensitive — the vocabulary
 * is PascalCase per upstream writer convention; `'collectiveknowledge'`
 * and `'COLLECTIVEKNOWLEDGE'` return `false`).
 *
 * Accepts `unknown` defensively: the writer guard calls this on
 * `observation.name` which may be `undefined` on malformed input — the
 * typeguard returns `false` rather than throwing, so the caller falls
 * through to the normal classifier path.
 *
 * @example
 * ```ts
 * if (isHierarchyRoot(observation.name)) {
 *   // observation.name is typed as HierarchyRoot here.
 *   const lockedClass = HIERARCHY_ROOT_CLASS[observation.name];
 *   // short-circuit the LLM classifier.
 * }
 * ```
 */
export function isHierarchyRoot(name: unknown): name is HierarchyRoot {
  return typeof name === 'string' && (HIERARCHY_ROOTS as readonly string[]).includes(name);
}

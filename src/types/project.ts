// Phase 57 D-03 — Project type registry: closed-set vocabulary for the
// `metadata.project` dimension stamped onto every km-core entity.
//
// SINGLE SOURCE OF TRUTH for the project list. Every writer (wave agents,
// canonical-mapper, km-core-adapter, online-mapper, legacy-ingest, the
// Phase 57 D-05 backfill) imports `isProject` from here before stamping
// `metadata.project`; every reader (viewer filters, dashboards, query
// helpers) imports `PROJECTS` so the project list cannot silently drift
// via free-text metadata values.
//
// Adding a new project is a code change in this file:
//   1. Append the new literal to the `PROJECTS` tuple (preserve order —
//      consumers may depend on positional indexing).
//   2. Update `tests/unit/project.test.ts` to lock the new vocabulary.
//   3. Update any consumer that hardcodes the project list (filter
//      dropdowns, classifier prompts, backfill heuristic).
//
// Pattern: combines the closed-set `as const` array + derived literal-union
// + runtime typeguard pattern. Mirrors the `Layer` literal-union convention
// in `src/types/entity.ts:27` for the layer dimension, and the branded-
// scalar typeguard convention in `src/ids/branded.ts` / `src/ids/parse.ts`
// for entity ids.

/** Closed-set project vocabulary (Phase 57 D-03). Order is load-bearing. */
export const PROJECTS = ['coding', 'okm', 'cap'] as const;

/** Derived literal-union type for compile-time `metadata.project` typing. */
export type Project = typeof PROJECTS[number];

/**
 * Runtime typeguard for `metadata.project` writers + readers.
 *
 * Returns `true` iff `x` is a string equal to one of the {@link PROJECTS}
 * tuple members (case-sensitive — the vocabulary is lowercase per D-03;
 * `'Coding'` and `'CODING'` return `false`).
 *
 * Writers call this before stamping `metadata.project` so an upstream
 * misspelling (e.g. `'codings'`) fails fast at the canonical-mapper or
 * km-core-adapter seam rather than silently widening the project
 * vocabulary via free-text metadata.
 *
 * @example
 * ```ts
 * if (isProject(rawTeam)) {
 *   metadata.project = rawTeam; // typed as Project here
 * }
 * ```
 */
export function isProject(x: unknown): x is Project {
  return typeof x === 'string' && (PROJECTS as readonly string[]).includes(x);
}

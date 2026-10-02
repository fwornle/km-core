// Phase 57 D-03 — Project type registry: the vocabulary for the
// `metadata.project` dimension stamped onto every km-core entity.
//
// Every writer (wave agents, canonical-mapper, km-core-adapter, online-mapper,
// legacy-ingest, the Phase 57 D-05 backfill) imports `isProject` from here
// before stamping `metadata.project`.
//
// The project is the TENANT, and the tenant is whatever scope the installation
// was given (~/.coding/scope, resolved by coding's lib/scope). It used to be a
// closed set — `['coding', 'okm', 'cap']` — which made every other team's
// install silently stamp NO project at all: `isProject('acme')` was false, the
// writers skip the stamp on false, and nothing logs. A closed set cannot be the
// gate for a value another team chooses.
//
// So the guard checks SHAPE, the same rule lib/scope applies when it resolves
// the scope in the first place: lowercase, safe as a path segment, at most
// PROJECT_MAX characters, and not the `'default'` placeholder (an install with
// no scope must not tag knowledge with one). Misspellings are no longer caught
// here; they cannot arise, because the tenant is resolved once by lib/scope
// rather than typed at each writer. coding's tests/scope/resolve.test.mjs fails
// if this rule and lib/scope's drift apart — km-core is a separate package and
// cannot import it.

/**
 * Projects this knowledge base has historically held. Informational — a
 * project does NOT have to be listed here to be valid; see {@link isProject}.
 * Order is load-bearing for consumers that index it positionally.
 */
export const PROJECTS = ['coding', 'okm', 'cap'] as const;

/** A project this knowledge base has historically held. */
export type KnownProject = typeof PROJECTS[number];

/** A tenant id that passed {@link isProject}. */
export type Project = string;

/** Same character rule as coding's lib/scope SCOPE_RE. */
export const PROJECT_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Same length cap as coding's lib/scope SCOPE_MAX. */
export const PROJECT_MAX = 64;

/** The scope an unconfigured install resolves to. Never a tenant. */
export const PLACEHOLDER_PROJECT = 'default';

/**
 * Runtime typeguard for `metadata.project` writers + readers.
 *
 * Returns `true` iff `x` is a well-formed tenant id: a lowercase string
 * matching {@link PROJECT_RE}, no longer than {@link PROJECT_MAX}, and not the
 * {@link PLACEHOLDER_PROJECT}. Case-sensitive — `'Coding'` returns `false`,
 * because lib/scope lowercases before anything is written.
 *
 * @example
 * ```ts
 * if (isProject(rawTeam)) {
 *   metadata.project = rawTeam;
 * }
 * ```
 */
export function isProject(x: unknown): x is Project {
  return typeof x === 'string'
    && x.length <= PROJECT_MAX
    && x !== PLACEHOLDER_PROJECT
    && PROJECT_RE.test(x);
}

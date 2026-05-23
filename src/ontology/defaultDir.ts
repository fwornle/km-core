// Resolves the path to the ontology JSON directory bundled with the
// km-core package. CLI authors and consumers that want default-class
// resolution against the live LearningArtifact upper + lowers should
// pass `ontologyDir: defaultOntologyDir()` into the `GraphKMStore`
// constructor.
//
// Rationale: Phase 41 Plan 41-07 surfaced a recurring authoring gap
// where CLI scripts constructed `GraphKMStore` without `ontologyDir`,
// then called `resolveEntities` without an explicit `classes` arg, and
// hit a runtime throw from `resolveTargetClasses`. The integration test
// (which DID set `ontologyDir`) masked the gap from pre-commit checks.
// This helper makes the right-shape construction one import + one call.
//
// Resolution strategy: walk up from this module's URL to the package
// root (`<root>/dist/ontology/defaultDir.js` → `<root>`) and join with
// `ontology`. This works for symlinked, npm-linked, and installed
// layouts identically. No filesystem probing.

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// Walk up from <root>/dist/ontology/ (compiled) or <root>/src/ontology/
// (running TS via tsx) to <root>, then append ontology.
const packageRoot = path.resolve(moduleDir, '..', '..');

/**
 * Absolute path to the live ontology directory bundled with `@fwornle/km-core`.
 *
 * Usage:
 * ```ts
 * import { GraphKMStore, defaultOntologyDir } from '@fwornle/km-core';
 * const store = new GraphKMStore({
 *   dbPath: '/tmp/km-store/leveldb',
 *   exportDir: '/tmp/km-store/exports',
 *   ontologyDir: defaultOntologyDir(),
 * });
 * ```
 *
 * Use this whenever the consumer plans to call `resolveEntities` without
 * an explicit `classes` arg — the resolver expands `LearningArtifact`
 * to its subclasses via `store.ontology` and throws when the registry
 * is absent.
 *
 * Override via the `KM_ONTOLOGY_DIR` env var when the consumer ships
 * its own ontology files (Phase 47+).
 */
export function defaultOntologyDir(): string {
  return process.env.KM_ONTOLOGY_DIR || path.join(packageRoot, 'ontology');
}

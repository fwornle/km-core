# Changelog

## [0.1.0] - 2026-05-31 — Phase 43 pre-req verification (no schema change)

Pre-req verification for **Phase 43 (OKM Cross-Repo Migration C, INT-03)**. No
source schema changes shipped — D-G4.2 confirmed in place, and OKM-side
OntologyRegistry accessor parity confirmed via grep against the existing public
surface.

### Verified

- `Entity.layer: 'evidence' | 'pattern'` is already a REQUIRED field on the
  canonical Entity (`src/types/entity.ts:27,120`). D-G4.2's "add `layer?`"
  wording was OKM-local-perspective; km-core already supports the union OKM
  uses. Outcome A per plan 43-01.
- `OntologyRegistry` exposes every accessor OKM consumers currently call:
  `isValidClass`, `getClass`, `getAllClassNames`, `getClassesForPrompt`,
  `getDefaultLayer`, `getValidRelationships`, `getLoadedDomains`. All confirmed
  at `src/ontology/registry.ts` (lines 173, 177, 181, 189, 201, 205, 211). No
  accessors added.

### Added

- `tests/unit/entity-layer-field.test.ts` — 3 round-trip tests covering
  `layer:'evidence'` and `layer:'pattern'` via `putEntity → getEntity →
  iterate → exportJson`. Locks the contract so OKM's post-cutover consumers
  (Plan 43-04+) compile + run cleanly.

### Documented (for Plan 43-04 adaptation, not a km-core change)

- OKM's local registry uses `new OntologyRegistry()` + `.load(dir)` (sync,
  two-step). km-core uses `new OntologyRegistry({ ontologyDir })` (auto-load
  in constructor) + async `reload()` for re-scan. Plan 43-04 must rewrite the
  call site at `_work/rapid-automations/integrations/operational-knowledge-management/src/index.ts:88-89`
  to use the constructor idiom. No km-core change required.

### Why

Phase 43 (OKM Cross-Repo Migration C) replaces OKM's local OntologyRegistry +
storage backend with km-core. This release verifies the cross-repo contract
without changing the public surface — Plans 43-02..43-11 pin against this
SHA via OKM's vendor tarball.

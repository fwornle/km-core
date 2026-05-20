// Pluggable ontology-validator interface (D-19).
//
// v0.1 ships a no-op default — `entityType` is accepted unconditionally.
// Phase 38 implements `OntologyRegistry` which conforms to this interface
// and replaces the no-op with real upper+lower-ontology validation.
// 37-PATTERNS §src/validation/ontology.ts pins the shape so Plan 04 can
// wire `GraphKMStoreOptions.ontologyValidator` without committing to the
// registry implementation today.

// Phase 38 (ONTO-01/02): type-only import of OntologyRegistry. This erases at
// compile time so this module has zero runtime dependency on the registry —
// the factory below only references `OntologyRegistry` in its parameter type
// and invokes `registry.isValidClass(entityType)` via duck-typed method call.
// Keeps the validator module load-light and breaks any potential circular
// import path with src/ontology/registry.ts (which must NOT import from this
// module — one-way dependency contract, verified by grep).
import type { OntologyRegistry } from '../ontology/registry.js';

export interface OntologyValidator {
  /** Throws an Error if `entityType` is not a registered ontology class. */
  validate(entityType: string): void;
}

/**
 * Default no-op validator. Accepts any `entityType` without inspection.
 * Plan 04 uses this when `GraphKMStoreOptions.ontologyValidator` is unset.
 * THREAT NOTE (T-37-02-04, threat_model row 4 — disposition: accept):
 * a bogus `entityType` reaches storage in v0.1 unless the consumer supplies
 * their own validator. Phase 38 closes this gap.
 */
export const noopOntologyValidator: OntologyValidator = {
  validate(_entityType: string): void {
    /* no-op */
  },
};

/**
 * Phase 38 (ONTO-01/02): factory returning an OntologyValidator backed by a
 * live OntologyRegistry. The returned validator's `validate(entityType)`
 * throws iff the registry's `isValidClass(entityType)` returns false; the
 * thrown error message text is the verbatim substring "Unknown ontology
 * class:" followed by the rejected `entityType`.
 *
 * The error-message contract is load-bearing: Phase 37's
 * tests/unit/graph-store.test.ts grep-asserts the regex
 * /Unknown ontology class/ against the thrown Error. Changing the message
 * text breaks that test. The same shape is used by the strict-mode stub at
 * lines 187-192 of that test file so the registry-backed path is a drop-in
 * replacement.
 *
 * Usage — direct (consumer-managed registry lifecycle):
 *   const registry = new OntologyRegistry({ ontologyDir: '/path/to/ontology' });
 *   const validator = registryBackedValidator(registry);
 *   const store = new GraphKMStore({ ..., ontologyValidator: validator });
 *
 * Usage — auto-wired (store-managed lifecycle, lands in Plan 38-05):
 *   const store = new GraphKMStore({ ..., ontologyDir: '/path/to/ontology' });
 *   // Plan 05 wires this factory internally; consumer never names it.
 *
 * Boundary preservation: the Phase 37 BC-2 trusted-bulk-import path
 * (`skipOntologyCheck: true`) bypasses the validator-call site entirely in
 * GraphKMStore.putEntity; this factory therefore inherits that bypass without
 * any additional code path. Non-trusted callers always go through the strict
 * path that invokes this validator.
 */
export function registryBackedValidator(registry: OntologyRegistry): OntologyValidator {
  return {
    validate(entityType: string): void {
      if (!registry.isValidClass(entityType)) {
        throw new Error(`Unknown ontology class: ${entityType}`);
      }
    },
  };
}

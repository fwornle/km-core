// Pluggable ontology-validator interface (D-19).
//
// v0.1 ships a no-op default — `entityType` is accepted unconditionally.
// Phase 38 implements `OntologyRegistry` which conforms to this interface
// and replaces the no-op with real upper+lower-ontology validation.
// 37-PATTERNS §src/validation/ontology.ts pins the shape so Plan 04 can
// wire `GraphKMStoreOptions.ontologyValidator` without committing to the
// registry implementation today.

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

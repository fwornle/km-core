// Ontology type surface for the Phase 38 Ontology Registry.
//
// SOURCE: adopted verbatim from OKM's
//   _work/rapid-automations/integrations/operational-knowledge-management/
//   src/types/ontology.ts (29 lines)
// Phase 38 ONTO-01 (auto-discovery) + ONTO-02 (extends + property merging)
// depend on this shape. Plan 38-01 owns the type-only foundation; Plan 38-03
// owns the registry that resolves classes against these interfaces.
//
// DELTA vs OKM analog (38-PATTERNS §src/types/ontology.ts "DELTAS"):
//   1. `OntologyClass.defaultLayer` is typed via the `Layer` import from
//      './entity.js' rather than inlining the `'evidence' | 'pattern'` literal.
//      Keeps the union a single source of truth (Phase 37 Plan 02 D-11
//      established `Layer` in src/types/entity.ts). No other functional delta.
//
// Two `extends?: string` fields exist deliberately:
//   - OntologyFile.meta.extends? — ontology-level inheritance (e.g. kpifw
//     declares meta.extends: "upper"), consumed by the registry to chain
//     lower-onto onto upper-onto.
//   - OntologyClass.extends? — per-class chain (e.g. KPIPipeline extends
//     Pipeline), consumed by registry.registerClasses() during merge.
// Same key name, different semantic level — preserve both per
// 38-PATTERNS landmines.

import type { Layer } from './entity.js';

export interface OntologyProperty {
  type: string;
  required?: boolean;
  enum?: string[];
  format?: string;
}

export interface OntologyClass {
  extends?: string;
  description: string;
  relationships: Record<string, string[]>;
  properties?: Record<string, OntologyProperty>;
  defaultLayer?: Layer;
}

export interface OntologyFile {
  meta: {
    name: string;
    version: string;
    extends?: string;
    description: string;
  };
  classes: Record<string, OntologyClass>;
}

export interface ResolvedClass extends OntologyClass {
  name: string;
  source: string;
}

// Barrel re-exports for the `src/ontology/` module (Phase 38, ONTO-01/02).
//
// Consumers needing the full registry surface in one import:
//   import { OntologyRegistry } from '@fwornle/km-core/ontology';
//   import type { OntologyClass, ResolvedClass } from '@fwornle/km-core/ontology';
//
// The sub-path `@fwornle/km-core/ontology` is wired in package.json `exports`
// (added in this plan per 38-PLAN-CHECK FLAG-1 option (a)). Consumers may also
// reach these symbols through the root barrel (`@fwornle/km-core`) — both
// import paths resolve to the same module.

export { OntologyRegistry } from './registry.js';
export type { OntologyRegistryOptions } from './registry.js';
export { loadOntologyFile } from './loader.js';
export type {
  OntologyFile,
  OntologyClass,
  OntologyProperty,
  ResolvedClass,
} from '../types/ontology.js';

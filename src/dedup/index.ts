// Barrel re-exports for the `src/dedup/` module (Phase 40, DEDUP-01).
//
// Consumers needing the layered dedup framework in one import:
//   import { LayeredDeduplicator, JaccardNameMatcher,
//            CosineEmbeddingMatcher, LLMSemanticMatcher } from '@fwornle/km-core/dedup';
//   import type { ExactNameLayer, EmbeddingLayer, LLMSemanticLayer,
//                 EmbeddingClient, LLMClient } from '@fwornle/km-core/dedup';
//
// The sub-path `@fwornle/km-core/dedup` is wired in package.json `exports`
// (mirrors Phase 38's `./ontology` sub-path precedent). Consumers may also
// reach these symbols through the root barrel (`@fwornle/km-core`) — both
// import paths resolve to the same module.

export { LayeredDeduplicator } from './LayeredDeduplicator.js';
export { JaccardNameMatcher } from './JaccardNameMatcher.js';
export { CosineEmbeddingMatcher } from './CosineEmbeddingMatcher.js';
export { LLMSemanticMatcher } from './LLMSemanticMatcher.js';
export type {
  ExactNameLayer,
  EmbeddingLayer,
  LLMSemanticLayer,
  MatchResult,
  DedupResult,
  EmbeddingClient,
  LLMClient,
} from './types.js';

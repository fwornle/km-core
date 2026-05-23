// Barrel re-exports for the `src/embeddings/` module (Phase 42 D-52c).
//
// Consumers can take the default embedding client via either sub-path or
// the root barrel:
//   import { FastembedEmbeddingClient } from '@fwornle/km-core/embeddings';
//   import { FastembedEmbeddingClient } from '@fwornle/km-core';
//
// The sub-path `@fwornle/km-core/embeddings` is wired in package.json
// `exports` — mirrors Phase 38 ./ontology + Phase 40 ./dedup + Phase 41
// ./maintenance precedent.

export { FastembedEmbeddingClient } from './FastembedEmbeddingClient.js';
export type {
  FastembedEmbeddingClientOpts,
  FastembedQueryable,
  FlagEmbeddingInit,
} from './FastembedEmbeddingClient.js';

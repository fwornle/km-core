// Co-located fake for CosineEmbeddingMatcher's EmbeddingClient interface.
// Moved here from Plan 40-01's universal fakes.ts per Warning #4
// (cross_plan_data_contracts) — fakes ship alongside the interfaces they
// satisfy. Keeps fakes.ts free of forward references to source files that
// land in later waves.
//
// File-name convention mirrors Plan 40-01's _helpers/fakes.ts: leading
// underscore on the parent dir + no `.test.` substring keeps the file out
// of vitest's default discovery (`include: ['tests/**/*.test.ts']`).
//
// Pattern source: 40-PATTERNS.md offset 723-738 (FakeEmbeddingClient
// pattern).

import { vi } from 'vitest';
import type { EmbeddingClient } from '../../../src/dedup/CosineEmbeddingMatcher.js';

/**
 * Build a deterministic fake `EmbeddingClient` for `CosineEmbeddingMatcher`
 * tests. When `opts.embeddings` keys a specific text, the fake returns that
 * vector verbatim — used by tests that need precise cosine scores. Otherwise
 * the fake returns a deterministic-per-text-length vector
 * (`Math.sin(i * text.length)`) so two different-length texts cluster near
 * cosine 0 without ever hitting a real embedding service.
 *
 * The returned `embed` is a `vi.fn(...)`, so callers can assert calls via
 * `expect(client.embed).toHaveBeenCalledWith(...)` (used by the `textOf`
 * override test).
 */
export function makeFakeEmbeddingClient(opts?: {
  embeddings?: Map<string, number[]>;
  defaultDim?: number;
}): EmbeddingClient {
  return {
    embed: vi.fn(async (text: string): Promise<number[]> => {
      if (opts?.embeddings?.has(text)) {
        return opts.embeddings.get(text)!;
      }
      const dim = opts?.defaultDim ?? 384;
      return new Array(dim).fill(0).map((_, i) => Math.sin(i * text.length));
    }),
  };
}

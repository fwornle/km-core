// Co-located fake for LLMSemanticMatcher's LLMClient interface. Moved here
// from Plan 40-01's universal fakes.ts per Warning #4 (cross_plan_data_contracts)
// — fakes ship alongside the interfaces they satisfy.
//
// The `LLMClient` interface is exported from `src/dedup/LLMSemanticMatcher.ts`
// (Plan 40-04 Task 2). Co-locating this fake here keeps Plan 40-01's
// `fakes.ts` free of forward references to still-uncreated source files.
//
// File-name convention: leading underscore in `_helpers/` + `fakes-llm.ts`
// (no `.test.` substring) keeps vitest's default test discovery
// (`include: ['tests/**/*.test.ts']`) from picking this file up.

import { vi } from 'vitest';
import type { LLMClient } from '../../../src/dedup/LLMSemanticMatcher.js';

/**
 * Factory for a deterministic fake `LLMClient` used by
 * `tests/unit/llm-matcher.test.ts`.
 *
 * The factory supports three injection modes:
 *
 *  - `opts.matches`     — structured matches list; the fake returns
 *                         `{ content: JSON.stringify({ matches }) }`.
 *  - `opts.raw`         — exact string payload for the response `content`
 *                         field. Used by the 5-stage JSON-unwrap tests
 *                         (anchored fence / unanchored fence / bare braces
 *                         / prose-wrapped).
 *  - `opts.throwError`  — the fake throws the supplied error on every
 *                         `complete()` call. Used by the `onError: 'skip'`
 *                         (stderr-warn + no-match) and `onError: 'throw'`
 *                         (re-throws) tests.
 *
 * `opts.raw` takes precedence over `opts.matches` when both are supplied.
 */
export function makeMockLLMClient(opts: {
  matches?: Array<{ newName: string; existingName: string }>;
  raw?: string;
  throwError?: Error;
}): LLMClient {
  return {
    complete: vi.fn(async (_req: Parameters<LLMClient['complete']>[0]) => {
      if (opts.throwError) throw opts.throwError;
      const payload =
        opts.raw ?? JSON.stringify({ matches: opts.matches ?? [] });
      return { content: payload };
    }),
  };
}

// Phase 40 Plan 04 (DEDUP-01 layer 3 of 3): LLM-semantic dedup layer.
//
// SOURCE: ported from OKM
//   _work/rapid-automations/integrations/operational-knowledge-management/
//   src/ingestion/deduplicator.ts
//     - lines 421-475 (`batchLLMDedup` — prompt + 5-stage JSON unwrap)
//     - lines 213-218 (try/catch with no-match fallback)
//     - lines 451-472 (defense-in-depth markdown-fence / bare-brace unwrap)
// with 5 deltas applied (per 40-PATTERNS Pattern F + 40-CONTEXT D-44 / D-46):
//
//   1. Implements the `LLMSemanticLayer` interface from src/dedup/types.ts
//      (D-44 — each layer exposes `readonly threshold` + async
//      `match(entity, candidates) => MatchResult`). OKM ran a single
//      monolithic `batchLLMDedup` that operated on whole class batches;
//      this matcher operates on one entity against an ontology-class-scoped
//      candidate pool (D-46) so it composes cleanly with the
//      LayeredDeduplicator's short-circuit contract.
//
//   2. `LLMClient` is a caller-supplied dependency interface owned by
//      this file. Each downstream system (rapid-llm-proxy for OKM, groq /
//      haiku for system A, etc.) wires its own client at the ctor.
//      Cross-batch state coordination is deferred per 40-CONTEXT.
//
//   3. Ctor options expose tunables with OKM's defaults:
//        - `threshold` defaults to 0.70 (40-RESEARCH A3 — OKM's implicit
//          "any match returned by LLM is taken").
//        - `timeoutMs` defaults to 60_000 (OKM `deduplicator.ts:448`).
//        - `taskType` defaults to `'deduplication_matching'`
//          (OKM `deduplicator.ts:446`).
//        - `onError` defaults to `'skip'` (40-RESEARCH Q5; mirrors OKM
//          `deduplicator.ts:213-218`'s try/catch + no-match fallback).
//
//   4. All `console.warn` lines from OKM are replaced with
//      `process.stderr.write` prefixed by `[km-core/dedup/llm]` — matches
//      the production stderr-warn convention from src/segments/merge.ts:134
//      and the broader Phase 37/38/39 no-console-log rule.
//
//   5. Prompt strings are verbatim from OKM `deduplicator.ts:430-444`
//      (system + user roles, "OOM" vs "Out of Memory" example included).
//      Do NOT rephrase — the OKM phrasing is load-bearing for production
//      tuning across all three downstream adapters.
//
// no-console-log: the only diagnostic site is the catch-stderr-warn, which
// uses `process.stderr.write` exclusively.

import type { Entity } from '../types/entity.js';
import type { LLMSemanticLayer, MatchResult } from './types.js';

/**
 * Caller-supplied LLM client. Phase 43 wires OKM's `@rapid/llm-proxy`;
 * Phases 41 + 42 wire their respective providers (groq, haiku, ...).
 *
 * `taskType` acts as a routing hint for proxy-based clients (default
 * `'deduplication_matching'` tier). `responseFormat: { type: 'json_object' }`
 * requests JSON-only emission where the provider supports it; even when
 * honored, the response may still arrive wrapped in markdown fences —
 * `parseDedupResponse` handles all four wrap modes defensively.
 *
 * `timeout` is the per-provider timeout in milliseconds; OKM's default is
 * 60_000 because dedup prompts grow with existing entity count.
 */
export interface LLMClient {
  complete(req: {
    messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string;
    }>;
    taskType?: string;
    responseFormat?: { type: 'json_object' };
    timeout?: number;
  }): Promise<{ content: string }>;
}

/**
 * Ctor options for `LLMSemanticMatcher`.
 *
 * Defaults:
 *   - `threshold`: 0.70 (40-RESEARCH A3 — OKM's implicit threshold).
 *   - `timeoutMs`: 60_000 (OKM `deduplicator.ts:448`).
 *   - `taskType`: `'deduplication_matching'` (OKM `deduplicator.ts:446`).
 *   - `onError`: `'skip'` — returns `{ matched: false, confidence: 0 }` and
 *     emits a `[km-core/dedup/llm]` stderr warning. Mirrors OKM's tolerant
 *     try/catch (`deduplicator.ts:213-218`) so LLM failures don't block
 *     ingest. Set to `'throw'` to propagate the error to the caller (the
 *     LayeredDeduplicator's per-layer try/catch will surface it).
 */
export interface LLMSemanticMatcherOpts {
  client: LLMClient;
  threshold?: number;
  timeoutMs?: number;
  taskType?: string;
  onError?: 'skip' | 'throw';
}

/**
 * LLM-semantic dedup layer (D-44 layer 3 of 3). Sends `entity.name` + the
 * candidate names to a caller-supplied `LLMClient` and returns the matched
 * survivor when the LLM identifies a duplicate.
 *
 * Threshold default 0.70 is OKM's implicit "any match returned by LLM is
 * taken" value. Phase 40 emits `confidence: this.threshold` when matched —
 * the LLM doesn't quantify confidence on a per-match basis; we record the
 * threshold as the floor. Callers tuning false-positive vs false-negative
 * tradeoffs adjust at the ctor; the LLM's verdict is binary.
 *
 * Candidates are ontology-class-scoped per D-46 (the LayeredDeduplicator
 * sources the candidate pool before each call). This matcher does NOT
 * re-filter.
 */
export class LLMSemanticMatcher implements LLMSemanticLayer {
  readonly threshold: number;
  private client: LLMClient;
  private timeoutMs: number;
  private taskType: string;
  private onError: 'skip' | 'throw';

  constructor(opts: LLMSemanticMatcherOpts) {
    this.client = opts.client;
    this.threshold = opts.threshold ?? 0.70;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.taskType = opts.taskType ?? 'deduplication_matching';
    this.onError = opts.onError ?? 'skip';
  }

  async match(entity: Entity, candidates: Entity[]): Promise<MatchResult> {
    if (candidates.length === 0) {
      return { matched: false, confidence: 0 };
    }
    // Pitfall 1 defense: prefer ontologyClass; fall back to entityType.
    const ontologyClass = entity.ontologyClass ?? entity.entityType;
    const existingNames = candidates
      .filter((c) => c.id !== entity.id)
      .map((c) => c.name);
    if (existingNames.length === 0) {
      return { matched: false, confidence: 0 };
    }

    try {
      const response = await this.client.complete({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT(ontologyClass) },
          {
            role: 'user',
            content: USER_PROMPT(ontologyClass, [entity.name], existingNames),
          },
        ],
        taskType: this.taskType,
        responseFormat: { type: 'json_object' },
        timeout: this.timeoutMs,
      });
      const parsed = parseDedupResponse(response.content);
      const match = parsed.matches?.find((m) => m.newName === entity.name);
      if (!match) {
        return { matched: false, confidence: 0 };
      }
      const survivor = candidates.find((c) => c.name === match.existingName);
      return survivor
        ? { matched: true, survivor, confidence: this.threshold }
        : { matched: false, confidence: 0 };
    } catch (err) {
      if (this.onError === 'throw') throw err;
      process.stderr.write(
        '[km-core/dedup/llm] match error for "' +
          entity.name +
          '" — skipping: ' +
          (err instanceof Error ? err.message : String(err)) +
          '\n',
      );
      return { matched: false, confidence: 0 };
    }
  }
}

// Prompt strings — verbatim from OKM `deduplicator.ts:430-444`. DO NOT
// rephrase. The "OOM" vs "Out of Memory" example is load-bearing for OKM's
// production tuning.
const SYSTEM_PROMPT = (ontologyClass: string): string =>
  `You are an entity deduplication assistant. Given a list of new entity names and existing entity names (all of ontology class "${ontologyClass}"), identify which new entities are semantic duplicates of existing ones.

Return a JSON object with a "matches" array. Each match has "newName" (the new entity name) and "existingName" (the existing entity name it duplicates).

Only include matches where you are confident the entities refer to the same real-world concept (e.g., "OOM" and "Out of Memory" are the same). If no duplicates exist, return {"matches": []}.`;

const USER_PROMPT = (
  ontologyClass: string,
  newNames: string[],
  existingNames: string[],
): string =>
  `Ontology class: ${ontologyClass}

New entities: ${JSON.stringify(newNames)}
Existing entities: ${JSON.stringify(existingNames)}

Identify semantic duplicates.`;

// 5-stage JSON unwrap — verbatim port from OKM `deduplicator.ts:451-472`.
// Stages: trim → anchored fence → unanchored fence → bare-brace extraction
// → JSON.parse. Each stage is a guarded fallthrough; the first stage that
// produces valid JSON-shaped text wins.
function parseDedupResponse(
  raw: string,
): { matches?: Array<{ newName: string; existingName: string }> } {
  let s = raw.trim();
  // Anchored fence: entire payload is ```json\n...\n``` (possibly with
  // surrounding whitespace).
  const fenceMatch = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/);
  if (fenceMatch) {
    s = fenceMatch[1].trim();
  } else {
    // Unanchored fence: fenced block lives somewhere in the response
    // (e.g. "Sure, here is the JSON:\n```json\n{...}\n```\n...").
    const unanchored = s.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
    if (unanchored) {
      s = unanchored[1].trim();
    } else if (!s.startsWith('{') && !s.startsWith('[')) {
      // Bare-brace extraction: prose-wrapped JSON. Slice from the first
      // `{` to the last `}` and hope for the best.
      const firstBrace = s.indexOf('{');
      if (firstBrace >= 0) {
        const lastBrace = s.lastIndexOf('}');
        if (lastBrace > firstBrace) {
          s = s.slice(firstBrace, lastBrace + 1);
        }
      }
    }
  }
  return JSON.parse(s);
}

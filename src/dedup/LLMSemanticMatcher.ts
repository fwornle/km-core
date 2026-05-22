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
 * Typed error thrown by {@link LLMSemanticMatcher.match} in
 * `onError: 'throw'` mode when the LLM response cannot be parsed
 * even after the 5-stage candidate-list unwrap. Closes CR-03
 * (40-REVIEW.md) — callers can `instanceof`-discriminate parse
 * failures from network errors / timeouts / other LLM-client errors.
 *
 * - `raw` — the first 1000 chars of the LLM's original response
 *   (truncated to avoid huge / PII payloads in error chains).
 * - `cause` — the underlying SyntaxError (Node 16+ Error cause).
 *
 * Contract A (40-10-PLAN.md): this error is constructed ONLY when the
 * raw LLM response contains at least one `{` (i.e. the LLM attempted
 * JSON). Prose-only responses with no `{` are silent no-match — no
 * throw, no stderr.
 */
export class LLMDedupParseError extends Error {
  readonly raw: string;
  constructor(message: string, opts: { raw: string; cause?: unknown }) {
    super(
      message,
      opts.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = 'LLMDedupParseError';
    this.raw = opts.raw.slice(0, 1000);
  }
}

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
    // CR-02 fix (40-REVIEW.md): no self-id filter. By D-46 (active-only
    // candidate pool), an exact id collision means the same logical
    // entity — which IS what dedup is meant to catch (legacy-id
    // re-extraction). Self-write protection is the store's job, not
    // the matcher's. See 40-REVIEW.md CR-02 + 40-VERIFICATION.md gap #2.
    const existingNames = candidates.map((c) => c.name);
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
      const parseResult = parseDedupResponse(response.content);

      // CR-03 + Contract A (40-10-PLAN.md): distinguish "LLM attempted
      // JSON but it failed to parse" from "LLM responded with prose-only
      // refusal / no-match". Heuristic: if response.content contains at
      // least one `{`, the LLM tried to send JSON. If ALL candidate
      // unwrap stages failed to JSON.parse (`parseResult.ok === false`),
      // surface a typed LLMDedupParseError. If response.content has NO
      // `{`, fall through to the normal no-match path (silent — no
      // throw, no stderr-warn). If parse SUCCEEDED but matches is empty,
      // that's a genuine canonical no-match — also silent.
      const parsedTriedJson = response.content.includes('{');
      if (parsedTriedJson && !parseResult.ok) {
        throw new LLMDedupParseError(
          'LLMSemanticMatcher: failed to parse LLM response',
          { raw: response.content, cause: parseResult.error },
        );
      }
      const parsed = parseResult.ok ? parseResult.value : { matches: [] };

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
      // onError: 'skip' — stderr-warn + no-match fallback.
      const isParseErr = err instanceof LLMDedupParseError;
      const prefix = isParseErr ? 'parse error' : 'match error';
      const suffix = isParseErr
        ? ' (raw response: ' +
          (err as LLMDedupParseError).raw.slice(0, 200) +
          ')'
        : '';
      process.stderr.write(
        '[km-core/dedup/llm] ' +
          prefix +
          ' for "' +
          entity.name +
          '" — skipping: ' +
          (err instanceof Error ? err.message : String(err)) +
          suffix +
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

/**
 * Discriminated parse result from `parseDedupResponse`. Lets `match()`
 * tell "all candidate unwraps failed JSON.parse" (CR-03 typed-error
 * path) from "candidates parsed cleanly but matches is empty" (genuine
 * no-match — silent).
 */
type ParsedDedupShape = {
  matches?: Array<{ newName: string; existingName: string }>;
};
type ParseDedupResult =
  | { ok: true; value: ParsedDedupShape }
  | { ok: false; error: unknown };

// CR-03 + WR-08 fix (40-REVIEW.md offset 311-340 recipe). The unwrap
// is now a candidate-list-of-tries: each stage CONTRIBUTES a candidate
// string when it can; we then try JSON.parse on each candidate in
// order. If ALL candidates fail, return `{ ok: false, error }` so
// match() can surface a typed LLMDedupParseError (Contract A — see
// 40-10-PLAN.md). The pre-rewrite first-stage-match-wins mutation chain
// starved Stages 2/3/4 when an earlier stage matched but emitted
// non-parseable text — that's the WR-08 defect this candidate-list
// pattern closes.
//
// PRIOR ART (Plan 40-04): The 5-stage OKM unwrap covered 4 response
// shapes — anchored fence, unanchored fence, bare-brace, raw JSON.
// The rewrite preserves all 4 by adding them as separate candidates
// (Stage 4 'raw' = the input as-given, which covers the raw-JSON
// case). canonicalEmptyResponse is now obsolete: `parseResult.ok`
// directly distinguishes the genuine canonical-empty answer (parse
// succeeded → ok: true → match() does NOT throw) from the all-failed
// case (ok: false → match() throws LLMDedupParseError when `{` was
// present in the raw response).
function parseDedupResponse(raw: string): ParseDedupResult {
  const s = raw.trim();
  const candidates: string[] = [];

  // Stage 1: anchored fence (entire payload is ```json\n...\n```).
  const anchored = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/);
  if (anchored) candidates.push(anchored[1].trim());

  // Stage 2: unanchored fence (fenced block somewhere in the response,
  // e.g. "Sure, here is the JSON:\n```json\n{...}\n```\n...").
  const unanchored = s.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (unanchored) candidates.push(unanchored[1].trim());

  // Stage 3: bare-brace extraction (prose-wrapped JSON).
  if (!s.startsWith('{') && !s.startsWith('[')) {
    const firstBrace = s.indexOf('{');
    const lastBrace = s.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidates.push(s.slice(firstBrace, lastBrace + 1));
    }
  }

  // Stage 4: raw (covers the LLM-emits-pure-JSON case).
  candidates.push(s);

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) as ParsedDedupShape };
    } catch (err) {
      lastError = err;
      // try next candidate
    }
  }
  // All candidates failed. match() surfaces a typed
  // LLMDedupParseError when the raw response contained at least one `{`
  // (Contract A — parsed-JSON-attempt path).
  return { ok: false, error: lastError };
}

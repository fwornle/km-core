// Phase 39 (DATA-02): per-segment provenance merge helper.
//
// SOURCE: lifted from OKM
//   _work/rapid-automations/integrations/operational-knowledge-management/
//   src/ingestion/deduplicator.ts (lines 380-416)
// with 4 deltas applied (per 39-PATTERNS §"src/segments/merge.ts" + 39-CONTEXT
// D-39 / D-40 / D-41):
//
//   1. D-40 whitespace normalization replaces OKM's `s.text === newText`
//      exact-equality with normalized comparison
//      (`text.trim().replace(/\s+/g, ' ')`). Case-sensitive — preserves
//      `Code` vs `code` distinction. `\s` also matches NBSP + ideographic
//      space, so cross-script whitespace variants collapse to the same key.
//
//   2. D-39 pure function. OKM mutates the segments array in place; Phase 39
//      returns a NEW `Entity` with a deep-cloned `descriptionSegments[]`
//      (each segment + each `confirmations[]` array reference-distinct from
//      the input) so callers can't accidentally rely on identity.
//
//   3. Signature change. OKM takes the segments array + IngestionContext +
//      text; Phase 39 takes the WHOLE `Entity` + a fully-constructed
//      `DescriptionSegment`. The metadata-key lookup is hidden inside the
//      helper — caller doesn't need to know `metadata.descriptionSegments`.
//
//   4. D-41 segment-cap monitoring. Emits a `process.stderr.write` warning
//      when the entity has >100 segments OR a matched segment's
//      `confirmations[]` exceeds 50 entries. No hard cap (pruning policy
//      is deferred per CONTEXT.md "Deferred Ideas").
//
// no-console-log: diagnostic output uses `process.stderr.write` only
// (mirrors `src/store/exporter.ts:112` idiom). Phase 39 D-41 monitoring.

import type {
  Entity,
  DescriptionSegment,
  SegmentConfirmation,
} from '../types/entity.js';

/** D-41 monitoring threshold: stderr-warn fires when entity has >100 segments. */
const MAX_SEGMENTS_WARN = 100;
/** D-41 monitoring threshold: stderr-warn fires when a segment has >50 confirmations. */
const MAX_CONFIRMATIONS_WARN = 50;

/**
 * D-40 whitespace normalization for the identical-text test.
 *
 * Returns `text.trim().replace(/\s+/g, ' ')` — collapses any run of
 * Unicode whitespace (including ASCII space, tab, newline, NBSP ` `,
 * ideographic space `　`) into a single ASCII space, with leading +
 * trailing whitespace stripped. Case-sensitive: `'Code'` and `'code'`
 * normalize to themselves and remain distinct.
 */
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * Fold a new `DescriptionSegment` into the entity's
 * `metadata.descriptionSegments[]`. Pure function: returns a NEW `Entity`
 * with a new `metadata` object and a new (deep-cloned)
 * `descriptionSegments[]` — the input `entity` reference is NEVER mutated.
 *
 * Whitespace-normalized + case-sensitive identical-text test (D-40):
 *   - `'hello world'` and `'hello  world'` (double space) merge as identical.
 *   - NBSP (` `) and ideographic space (`　`) collapse to ASCII
 *     space — `'hello world'` matches `'hello world'`.
 *   - `'Code'` and `'code'` remain distinct (case-sensitive).
 *
 * If a normalized-identical existing segment is found (D-40 hit):
 *   - Append a `SegmentConfirmation` `{ runId, provider, model, timestamp }`
 *     (extracted from `newSegment`) to that segment's `confirmations[]`.
 *   - Do NOT push a new segment.
 * Otherwise (D-40 miss):
 *   - Push `newSegment` (preserving caller-supplied `confirmations[]`; if
 *     the caller omitted it / passed `undefined`, initialize to `[]`).
 *
 * Entity with `metadata: {}` (Phase 37/38 default — no `descriptionSegments`
 * key) is handled — the helper initializes the array on the returned entity.
 *
 * D-41 monitoring: emits `process.stderr.write` warning (no `console.*`)
 * when the resulting segments array exceeds `MAX_SEGMENTS_WARN` (100), or
 * when a matched segment's `confirmations[]` exceeds `MAX_CONFIRMATIONS_WARN`
 * (50). These are monitoring signals only — no hard cap; pruning deferred.
 */
export function mergeDescriptionSegment(
  entity: Entity,
  newSegment: DescriptionSegment,
): Entity {
  const existingMetadata = entity.metadata ?? {};
  const existingSegments =
    ((existingMetadata as Record<string, unknown>)
      .descriptionSegments as DescriptionSegment[] | undefined) ?? [];

  // D-39 deep clone: neither the segments array, the segment objects, nor
  // their confirmations[] are reference-shared with the input. Phase 37/38
  // callers that hold the input `entity` reference see ZERO mutation.
  const segments: DescriptionSegment[] = existingSegments.map((s) => ({
    ...s,
    confirmations: [...(s.confirmations ?? [])],
  }));

  const normalizedNew = normalize(newSegment.text);
  const matchIndex = segments.findIndex(
    (s) => normalize(s.text) === normalizedNew,
  );

  if (matchIndex >= 0) {
    // D-40 hit: append confirmation to the matched segment.
    const match = segments[matchIndex];
    const confirmation: SegmentConfirmation = {
      runId: newSegment.runId,
      provider: newSegment.provider,
      model: newSegment.model,
      timestamp: newSegment.timestamp,
    };
    match.confirmations.push(confirmation);
    if (match.confirmations.length > MAX_CONFIRMATIONS_WARN) {
      process.stderr.write(
        `[km-core/segments] entity ${String(entity.id)} segment ${String(matchIndex)} has ${String(match.confirmations.length)} confirmations (>${String(MAX_CONFIRMATIONS_WARN)}, monitoring per D-41)\n`,
      );
    }
  } else {
    // D-40 miss: push the new segment (preserve caller-supplied
    // confirmations[] per "Gotcha — empty confirmations[]" in PATTERNS.md).
    segments.push({
      ...newSegment,
      confirmations: newSegment.confirmations ?? [],
    });
    if (segments.length > MAX_SEGMENTS_WARN) {
      process.stderr.write(
        `[km-core/segments] entity ${String(entity.id)} has ${String(segments.length)} descriptionSegments (>${String(MAX_SEGMENTS_WARN)}, monitoring per D-41)\n`,
      );
    }
  }

  return {
    ...entity,
    metadata: { ...existingMetadata, descriptionSegments: segments },
  };
}

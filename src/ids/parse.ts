/**
 * `parseEntityId` — validate a caller-supplied string is a well-formed
 * UUIDv7 and, on success, return it branded as `EntityId`.
 *
 * Cites:
 *   - D-10: Callers may supply their own IDs (for idempotency / dedup
 *           short-circuit). Every caller-supplied ID MUST pass through
 *           this validator before reaching storage.
 *   - 37-RESEARCH §Pitfall 2: defending against caller-supplied wide
 *           `string` values that would otherwise collide with internal
 *           UUIDv7 IDs.
 *   - 37-PATTERNS §src/ids/parse.ts DELTAS: the `uuidv7` package's
 *           `UUID.parse` accepts ANY RFC 9562 UUID — including v4 — so
 *           we additionally assert the version nibble at string position
 *           14 is `'7'`. This rejects v4 UUIDs (which have `'4'` there)
 *           and satisfies CORE-03's "caller-supplied invalid id throws"
 *           acceptance criterion.
 *
 * @throws SyntaxError on any input that is not a valid UUID OR is a
 *         non-v7 RFC 9562 UUID.
 */
import { UUID } from 'uuidv7';
import type { EntityId } from './branded.js';

export function parseEntityId(s: string): EntityId {
  // 1. Reject anything that is not a syntactically valid RFC 9562 UUID.
  //    UUID.parse throws SyntaxError on bad input.
  UUID.parse(s);

  // 2. Defensive variant check: position 14 (0-indexed) of the canonical
  //    8-4-4-4-12 hyphenated form is the version nibble. UUIDv7 pins it
  //    to '7'. UUID.parse alone accepts v4 (and other versions) — this
  //    check is the second half of the CORE-03 "invalid id throws" gate.
  if (s.charAt(14) !== '7') {
    throw new SyntaxError(
      'Not a UUIDv7: variant byte mismatch at position 14',
    );
  }

  return s as EntityId;
}

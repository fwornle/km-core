/**
 * `mintEntityId` — the only sanctioned way to produce a fresh entity
 * identifier. Returns a UUIDv7 (RFC 9562, 2024) cast to the branded
 * `EntityId` type.
 *
 * Cites:
 *   - D-08: UUIDv7 variant chosen for time-ordered k-sortable IDs.
 *   - D-09: `uuidv7` npm package (~3 KB, RFC-9562-compliant).
 *   - D-11: Branded `EntityId` enforces compile-time discipline at API
 *           boundaries; raw `string` values do not satisfy parameters of
 *           type `EntityId`.
 */
import { uuidv7 } from 'uuidv7';
import type { EntityId } from './branded.js';

export function mintEntityId(): EntityId {
  return uuidv7() as EntityId;
}

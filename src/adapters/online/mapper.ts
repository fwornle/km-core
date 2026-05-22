// Phase 41 Plan 02 (INT-01): pure row-to-Entity mappers for A's online-learning
// observation/digest/insight export rows.
//
// SOURCE: shape mirrors src/segments/merge.ts (pure-function transform, no I/O,
// .js relative imports, type-only Entity import). The mapper module is the
// READ-ONLY adapter half of INT-01 — Plan 04 (reproject) consumes these
// mappers and is the only path that touches the store.
//
// CRITICAL — canonical legacyId placement (CF-D37, entity.ts:147,
// backfill/index.ts:238):
//   * entity.legacyId = { system: 'A', id: <row.id> }  ← TOP-LEVEL Entity field
//   * entity.metadata.subsystem = 'online'              ← SEPARATE metadata key
//
// The Entity.legacyId.system union stays narrow ('A' | 'B' | 'C') — the
// 'online' discriminator lives on metadata, NOT inside legacyId. Idempotency
// scans (Plan 04, future Phase 42/43) hash on the TOP-LEVEL
// entity.legacyId.id and filter on legacyId.system === 'A' &&
// metadata.subsystem === 'online'.
//
// no-console-log: mappers are pure — no diagnostic emission. The reproject
// function in Plan 04 owns any process.stderr.write calls.

import type { Entity } from '../../types/entity.js';

/**
 * Maximum length of the derived name field (CONTEXT.md / PATTERNS — keep
 * names ≤120 chars so VKB tooltips + graph labels render cleanly).
 */
const NAME_MAX_LENGTH = 120;

/** Placeholder name when a row's summary/theme/topic is empty. */
const EMPTY_NAME_PLACEHOLDER = '(empty)';

/**
 * A's observation export row shape. Mirrors
 * `.data/observation-export/observations.json` records (see 41-PATTERNS
 * "Source row shape").
 */
export interface ObservationRow {
  id: string;
  summary: string;
  agent: string;
  project: string;
  quality: string;
  createdAt: string;
  digestedAt?: string | null;
  llm?: string | null;
  modifiedFiles?: string[] | null;
}

/**
 * A's daily-digest export row shape. Mirrors
 * `.data/observation-export/digests.json` records.
 */
export interface DigestRow {
  id: string;
  date: string;
  theme: string;
  summary: string;
  observationIds: string[];
  agents: string[];
  filesTouched: string[];
  quality?: string;
  project?: string;
  createdAt?: string;
}

/**
 * A's insight export row shape. Mirrors
 * `.data/observation-export/insights.json` records.
 */
export interface InsightRow {
  id: string;
  topic: string;
  summary: string;
  confidence: number;
  digestIds: string[];
  project?: string;
  createdAt?: string;
}

/**
 * Derive a short display name from a multi-line summary.
 *
 * Returns the first non-empty line of `text`, trimmed and sliced to
 * `NAME_MAX_LENGTH` characters. Falls back to `'(empty)'` when no
 * non-empty line is found (covers `''`, `'\n\n'`, all-whitespace cases).
 *
 * Module-private — exported only for the tests that pin name-derivation
 * semantics indirectly via the mappers.
 */
function deriveName(text: string): string {
  if (typeof text !== 'string' || text.length === 0) {
    return EMPTY_NAME_PLACEHOLDER;
  }
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed.slice(0, NAME_MAX_LENGTH);
    }
  }
  return EMPTY_NAME_PLACEHOLDER;
}

/**
 * Convert an A-side observation row into a KM-Core `Entity`.
 *
 * Pure function — no I/O, no store coupling. The returned Entity is a
 * partial that intentionally OMITS `id` and `updatedAt`; Plan 04's
 * `reprojectFromOnlineStore` mints/resolves the canonical `EntityId` via
 * the legacyId resolver pattern (CF-D37) before calling
 * `store.putEntity({ skipOntologyCheck: true })`. The strict
 * `parseEntityId` does not run on the trusted path, so a not-yet-v7 id
 * is accepted by the store at that point.
 *
 * Stamps:
 *   - `entityType: 'Observation'`, `ontologyClass: 'Observation'`
 *   - `description: row.summary`, `createdAt: row.createdAt`
 *   - `validFrom: row.createdAt` so D-34 active-only queries preserve
 *     source ordering on the reprojection path.
 *   - `legacyId: { system: 'A', id: row.id }` at the TOP LEVEL of Entity
 *     (CF-D37 canonical placement, NOT inside metadata).
 *   - `metadata.subsystem: 'online'` as the SEPARATE subsystem
 *     discriminator (NOT nested inside legacyId).
 *   - `metadata.modifiedFiles: row.modifiedFiles ?? []` — null collapses
 *     to empty array so consumers can iterate without a guard.
 *   - `metadata.llm: row.llm` ONLY if non-null/undefined; otherwise the
 *     key is omitted entirely from metadata.
 *   - `metadata.digestedAt: row.digestedAt` ONLY if non-null/undefined.
 */
export function mapObservationRow(row: ObservationRow): Entity {
  const metadata: Record<string, unknown> = {
    subsystem: 'online',
    project: row.project,
    agent: row.agent,
    quality: row.quality,
    modifiedFiles: row.modifiedFiles ?? [],
  };
  if (row.llm !== null && row.llm !== undefined) {
    metadata.llm = row.llm;
  }
  if (row.digestedAt !== null && row.digestedAt !== undefined) {
    metadata.digestedAt = row.digestedAt;
  }
  return {
    // id is intentionally omitted — Plan 04 mints/resolves it via the
    // legacyId resolver. Cast satisfies the strict `Entity` type so
    // downstream consumers can type against `Entity` directly; the
    // store's trusted path tolerates the missing id and overwrites it.
    name: deriveName(row.summary),
    entityType: 'Observation',
    ontologyClass: 'Observation',
    layer: 'evidence',
    description: row.summary,
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
    validFrom: row.createdAt,
    metadata,
    legacyId: { system: 'A', id: row.id },
  } as Entity;
}

/**
 * Convert an A-side daily-digest row into a KM-Core `Entity`.
 *
 * Same id-omission contract as `mapObservationRow` (Plan 04 owns id
 * stamping). Top-level legacyId per CF-D37; metadata.subsystem separate.
 *
 * Stamps:
 *   - `entityType: 'Digest'`, `ontologyClass: 'Digest'`
 *   - `name: row.theme`
 *   - `metadata.observationIds`, `metadata.agents`, `metadata.filesTouched`,
 *     `metadata.date` — array fields default to `[]` if undefined.
 *   - `createdAt / validFrom: row.createdAt ?? row.date` so digests
 *     without a createdAt still sort sensibly.
 */
export function mapDigestRow(row: DigestRow): Entity {
  const createdAt = row.createdAt ?? row.date;
  const metadata: Record<string, unknown> = {
    subsystem: 'online',
    date: row.date,
    observationIds: row.observationIds ?? [],
    agents: row.agents ?? [],
    filesTouched: row.filesTouched ?? [],
  };
  if (row.quality !== undefined) {
    metadata.quality = row.quality;
  }
  if (row.project !== undefined) {
    metadata.project = row.project;
  }
  return {
    name: row.theme && row.theme.length > 0 ? row.theme : EMPTY_NAME_PLACEHOLDER,
    entityType: 'Digest',
    ontologyClass: 'Digest',
    layer: 'evidence',
    description: row.summary,
    createdAt,
    updatedAt: createdAt,
    validFrom: createdAt,
    metadata,
    legacyId: { system: 'A', id: row.id },
  } as Entity;
}

/**
 * Convert an A-side insight row into a KM-Core `Entity`.
 *
 * Same id-omission + top-level legacyId + separate metadata.subsystem
 * contract as the other two mappers.
 *
 * Stamps:
 *   - `entityType: 'Insight'`, `ontologyClass: 'Insight'`
 *   - `layer: 'pattern'` (insights are pattern-layer per
 *     ontology/learning-artifacts.json Plan 41-01)
 *   - `name: row.topic`
 *   - `metadata.digestIds`, `metadata.confidence`
 *   - `createdAt / validFrom: row.createdAt ?? <epoch>` — empty
 *     createdAt is uncommon but tolerated.
 */
export function mapInsightRow(row: InsightRow): Entity {
  const createdAt = row.createdAt ?? '1970-01-01T00:00:00.000Z';
  const metadata: Record<string, unknown> = {
    subsystem: 'online',
    digestIds: row.digestIds ?? [],
    confidence: row.confidence,
  };
  if (row.project !== undefined) {
    metadata.project = row.project;
  }
  return {
    name: row.topic && row.topic.length > 0 ? row.topic : EMPTY_NAME_PLACEHOLDER,
    entityType: 'Insight',
    ontologyClass: 'Insight',
    layer: 'pattern',
    description: row.summary,
    createdAt,
    updatedAt: createdAt,
    validFrom: createdAt,
    metadata,
    legacyId: { system: 'A', id: row.id },
  } as Entity;
}

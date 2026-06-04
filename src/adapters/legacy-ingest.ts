// Phase 44 Plan 12 (A-1 architectural close-out): legacy-ingest adapter —
// SQLite-shaped row → km-core Entity.
//
// SOURCE / RATIONALE:
//   - 44-CONTEXT-amendment-2.md identified the write-path gap left by Plan
//     44-07 (read-only cutover). ObservationWriter still wrote to SQLite,
//     so new observations were invisible to the dashboard (which reads
//     km-core via Plan 44-05's observation-view).
//   - This module is the INVERSE direction of `observation-view.ts` (sibling
//     file in this directory). The single source of truth for the field-map
//     that previously lived in `scripts/migrate-sqlite-to-kmcore.mjs`
//     (buildObservationEntity / buildDigestEntity / buildInsightEntity at
//     lines 170-266 of that script) is lifted here so that BOTH the live
//     `ObservationWriter` AND the migration script share one definition.
//   - Phase 41 D-13 contract: `legacyId.system = 'A'` for all three classes
//     (this module belongs to the A subsystem). Caller passes (runId, ts)
//     so the writer can synthesize a per-process runId and the migration
//     can use `phase-XX-runId`.
//   - Phase 39 D-30 contract: every entity carries `createdBy:
//     ProvenanceStamp` so future migrations + post-hoc resolution have full
//     provenance trail. Stamp is built per-call from (runId, ts).
//
// CRITICAL — Pitfall 3 (44-RESEARCH.md): every entity sets BOTH `entityType`
// AND `ontologyClass` because `GraphKMStore.findByOntologyClass(cls)` is an
// OR-gate (GraphKMStore.ts:577 — `entityType === cls || ontologyClass ===
// cls`). The Plan 44-07 typed views at `/api/coding/*` iterate via the same
// OR-check, so both fields MUST be populated.
//
// CRITICAL — canonical legacyId placement (CF-D37, entity.ts:147): legacyId
// is the TOP-LEVEL Entity field, NOT inside metadata. The `legacyId.id`
// field wins over `entity.id` in Plan 44-05's reshape (observationToLegacy
// fallback chain), so this is the canonical row-identity carrier.
//
// CRITICAL — trusted-path bulk-write semantics: the Observation/Digest/
// Insight ontology classes are NOT in the km-core bundled ontology (which
// ships only LearningArtifact subclasses). Both callers (writer + migration)
// MUST invoke `putEntity(entity, { skipOntologyCheck: true })` to bypass
// registry validation. The trusted-path also bypasses the D-30 provenance
// auto-assembly, so this module stamps `createdBy` itself — caller does NOT
// need to provide `opts.provenance`.
//
// PURITY: this module has NO I/O, NO async, NO LLM, NO logging. All three
// functions are pure transformers — same input always produces same output.
// Diagnostic emission lives in the caller (writer or migration script).
//
// no-console-log: the module is pure; no `console.*` or `process.stderr` calls.
//
// Filename: EXACTLY `legacy-ingest.ts` per km-core CLAUDE.md no-evolutionary
// names rule (sibling of observation-view.ts; mirrors the Plan 44-05 naming).

import type { Entity } from '../types/entity.js';
import type { EntityId } from '../ids/branded.js';

// ----------------------------------------------------------------------------
// Legacy row interfaces — mirror the SQLite SELECT projections used in
// scripts/migrate-sqlite-to-kmcore.mjs:377-389.
//
// The writer feeds these shapes directly (it constructs them from the
// `writeObservation/writeDigest/writeInsight` argument lists). The migration
// script feeds them from `db.prepare('SELECT ... FROM observations').all()`
// rows. Both shapes agree on the field set because the SQLite schema is the
// single source.
// ----------------------------------------------------------------------------

/**
 * Legacy observation row shape — fields written to SQLite by the pre-Plan-
 * 44-12 ObservationWriter (see ObservationWriter.js:715-731 prior to cutover).
 * The `metadata` field may arrive as a JSON string (migration script, which
 * reads `metadata TEXT`) or as an object (live writer, which holds the
 * structured value before serializing). `parseMetadata` below normalizes
 * both to `Record<string, unknown>`.
 */
export interface LegacyObservationRow {
  /** Primary key — the row's UUID. Becomes legacyId.id. */
  id: string;
  /** Body text (the LLM-generated 4-line summary). */
  summary: string;
  /** JSON-encoded array of MastraDB messages (kept for replay). */
  messages?: string | unknown[];
  /** Agent identifier (e.g. 'claude', 'copilot', 'opencode'). */
  agent: string | null;
  session_id?: string | null;
  source_file?: string | null;
  /** ISO timestamp of capture. */
  created_at: string;
  /** Either JSON string or pre-parsed object. Carries `project`, `modifiedFiles`, etc. */
  metadata?: string | Record<string, unknown> | null;
  content_hash?: string | null;
  quality?: string | null;
  /** When the consolidator folded this row into a digest. */
  digested_at?: string | null;
}

/**
 * Legacy daily-digest row shape — fields written to SQLite by
 * ObservationConsolidator.consolidateDay.
 */
export interface LegacyDigestRow {
  id: string;
  date: string;
  theme: string;
  summary: string;
  observation_ids?: string | string[] | null;
  agents?: string | string[] | null;
  files_touched?: string | string[] | null;
  quality?: string | null;
  created_at: string;
  metadata?: string | Record<string, unknown> | null;
  project?: string | null;
}

/**
 * Legacy insight row shape — fields written to SQLite by
 * ObservationConsolidator.synthesizeInsights.
 */
export interface LegacyInsightRow {
  id: string;
  topic: string;
  summary: string;
  confidence: number;
  digest_ids?: string | string[] | null;
  last_updated?: string | null;
  created_at: string;
  metadata?: string | Record<string, unknown> | null;
  project?: string | null;
}

// ----------------------------------------------------------------------------
// Internal helpers — JSON-safe parse + provenance stamp construction.
// ----------------------------------------------------------------------------

/**
 * Parse a value that may be a JSON string OR an already-decoded object into
 * a plain `Record<string, unknown>`. Returns `{}` on parse failure or
 * non-object input. Mirrors the migration script's `parseJsonOr(raw, {})`
 * pattern (migrate-sqlite-to-kmcore.mjs:146-153).
 */
function parseMetadata(
  raw: string | Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (raw === null || raw === undefined || raw === '') return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Parse a value into a string array. Accepts either a JSON-encoded string
 * (migration script reads `observation_ids TEXT`) or an already-decoded
 * array (live writer). Returns `[]` on parse failure or non-array input.
 * Mirrors migrate-sqlite-to-kmcore.mjs:155-158.
 */
function parseStringArray(
  raw: string | string[] | null | undefined,
): string[] {
  if (raw === null || raw === undefined || raw === '') return [];
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === 'string');
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Build a ProvenanceStamp for the createdBy / lastConfirmedBy fields.
 * The (runId, ts) pair is supplied by the caller so the writer can stamp
 * a per-process runId and the migration script can stamp `a-mig-<epoch>`.
 *
 * Mirrors migrate-sqlite-to-kmcore.mjs:160-166. The provider/model strings
 * are intentionally caller-specific — the writer uses 'observation-writer'
 * / 'live-pipeline', the migration uses 'phase-44-migration' / 'a-legacy-
 * to-kmcore'. To support both call sites with one helper, we accept the
 * provider/model as optional args; defaults match the writer's stamps so
 * the live-pipeline call site can be terse.
 */
function buildProvenance(
  runId: string,
  ts: string,
  provider: string,
  model: string,
): { provider: string; model: string; runId: string; timestamp: string } {
  return { provider, model, runId, timestamp: ts };
}

// ----------------------------------------------------------------------------
// Adapter functions — pure SQLite-row → km-core-Entity transformers.
//
// Each function:
//   * Sets BOTH `entityType` AND `ontologyClass` (Pitfall 3).
//   * Places `legacyId = { system: 'A', id: row.id }` at the TOP level (CF-D37).
//   * Stamps `createdBy: ProvenanceStamp` from (runId, ts) (Phase 39 D-30).
//   * Preserves every non-promoted SQLite column inside `metadata` so the
//     Plan 44-05 reshape can surface fields the legacy SELECTs returned
//     (Pitfall 2 — missing fields equal blank cells on the dashboard).
//   * Leaves `id` undefined so `GraphKMStore.putEntity` mints a fresh
//     UUIDv7 — the SQLite row id is preserved in legacyId.
//
// The optional `opts.provider` / `opts.model` arguments default to the
// live-writer provenance ('observation-writer' / 'live-pipeline') so the
// per-write call site stays terse; the migration script passes
// ('phase-44-migration', 'a-legacy-to-kmcore') to distinguish stamped rows.
// ----------------------------------------------------------------------------

/** Caller-supplied provenance discriminators (writer vs migration). */
export interface LegacyIngestOptions {
  provider?: string;
  model?: string;
}

const DEFAULT_WRITER_PROVIDER = 'observation-writer';
const DEFAULT_WRITER_MODEL = 'live-pipeline';

/**
 * Convert a legacy `observations` row into a km-core Entity for the
 * 'Observation' ontology class. Lifted from
 * `scripts/migrate-sqlite-to-kmcore.mjs:178-207` (buildObservationEntity)
 * with the parse-helpers normalized so the live writer can pass an
 * already-decoded `metadata: object` without re-serializing.
 *
 * @param row   The SQLite observation row (or the equivalent live-writer
 *              payload).
 * @param runId Per-process or per-migration run identifier.
 * @param ts    ISO timestamp for the provenance stamp.
 * @param opts  Optional provider/model overrides (default: live writer).
 */
export function legacyObservationToEntity(
  row: LegacyObservationRow,
  runId: string,
  ts: string,
  opts: LegacyIngestOptions = {},
): Entity {
  const meta = parseMetadata(row.metadata);
  const provider = opts.provider ?? DEFAULT_WRITER_PROVIDER;
  const model = opts.model ?? DEFAULT_WRITER_MODEL;
  // Preserve messages as-is — migration reads a JSON string from SQLite,
  // writer holds the structured array. Both round-trip through metadata.
  const messages = row.messages ?? null;
  return {
    // Cast: undefined is intentional — putEntity mints the EntityId on first
    // write (CORE-03 / mintEntityId). The cast satisfies the type at the
    // adapter boundary; the store enforces the brand at write time.
    id: undefined as unknown as EntityId,
    name: (row.summary || '').slice(0, 80) || '(no summary)',
    entityType: 'Observation',
    ontologyClass: 'Observation',
    layer: 'evidence',
    description: row.summary || '',
    metadata: {
      ...meta,
      agent: row.agent,
      project: meta.project ?? null,
      session_id: row.session_id ?? null,
      source_file: row.source_file ?? null,
      content_hash: row.content_hash ?? null,
      quality: row.quality ?? null,
      digested_at: row.digested_at ?? null,
      messages,
      summary: row.summary,
      createdAt: row.created_at,
    },
    legacyId: { system: 'A', id: row.id },
    createdAt: row.created_at,
    updatedAt: row.created_at,
    validFrom: row.created_at,
    validUntil: undefined,
    createdBy: buildProvenance(runId, ts, provider, model),
  } as Entity;
}

/**
 * Convert a legacy `digests` row into a km-core Entity for the 'Digest'
 * ontology class. Lifted from `scripts/migrate-sqlite-to-kmcore.mjs:209-237`
 * (buildDigestEntity). The three array columns (observation_ids, agents,
 * files_touched) are parsed via parseStringArray so the live writer can
 * pass them as `string[]` directly.
 */
export function legacyDigestToEntity(
  row: LegacyDigestRow,
  runId: string,
  ts: string,
  opts: LegacyIngestOptions = {},
): Entity {
  const meta = parseMetadata(row.metadata);
  const provider = opts.provider ?? DEFAULT_WRITER_PROVIDER;
  const model = opts.model ?? DEFAULT_WRITER_MODEL;
  return {
    id: undefined as unknown as EntityId,
    name: (row.theme || row.summary || '').slice(0, 80) || '(no theme)',
    entityType: 'Digest',
    ontologyClass: 'Digest',
    layer: 'pattern',
    description: row.summary || '',
    metadata: {
      ...meta,
      date: row.date,
      theme: row.theme,
      summary: row.summary,
      observation_ids: parseStringArray(row.observation_ids),
      agents: parseStringArray(row.agents),
      files_touched: parseStringArray(row.files_touched),
      project: row.project ?? meta.project ?? null,
      quality: row.quality ?? null,
      createdAt: row.created_at,
    },
    legacyId: { system: 'A', id: row.id },
    createdAt: row.created_at,
    updatedAt: row.created_at,
    validFrom: row.created_at,
    validUntil: undefined,
    createdBy: buildProvenance(runId, ts, provider, model),
  } as Entity;
}

/**
 * Convert a legacy `insights` row into a km-core Entity for the 'Insight'
 * ontology class. Lifted from `scripts/migrate-sqlite-to-kmcore.mjs:239-266`
 * (buildInsightEntity). The `last_updated` column doubles as the entity's
 * `updatedAt` (falls back to created_at when null).
 */
export function legacyInsightToEntity(
  row: LegacyInsightRow,
  runId: string,
  ts: string,
  opts: LegacyIngestOptions = {},
): Entity {
  const meta = parseMetadata(row.metadata);
  const provider = opts.provider ?? DEFAULT_WRITER_PROVIDER;
  const model = opts.model ?? DEFAULT_WRITER_MODEL;
  const lastUpdated = row.last_updated ?? null;
  return {
    id: undefined as unknown as EntityId,
    name: (row.topic || row.summary || '').slice(0, 80) || '(no topic)',
    entityType: 'Insight',
    ontologyClass: 'Insight',
    layer: 'pattern',
    description: row.summary || '',
    metadata: {
      ...meta,
      topic: row.topic,
      summary: row.summary,
      confidence: typeof row.confidence === 'number' ? row.confidence : 0.8,
      digest_ids: parseStringArray(row.digest_ids),
      last_updated: lastUpdated,
      project: row.project ?? meta.project ?? null,
      createdAt: row.created_at,
    },
    legacyId: { system: 'A', id: row.id },
    createdAt: row.created_at,
    updatedAt: lastUpdated || row.created_at,
    validFrom: row.created_at,
    validUntil: undefined,
    createdBy: buildProvenance(runId, ts, provider, model),
  } as Entity;
}

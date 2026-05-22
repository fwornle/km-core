// Phase 41 Plan 04 (INT-01): `reprojectFromOnlineStore` library function.
//
// Reads A's `.data/observation-export/{observations,digests,insights}.json`
// files, runs Plan 02's mappers, and writes the resulting Entity + Relation
// records into a caller-supplied GraphKMStore. Idempotent (top-level
// `legacyId` resolver scan with subsystem filter per CF-D37), checkpoint-
// resumable (atomic temp-rename per CF-D38), read-only against A's writer.
//
// Purpose: INT-01 SC#1 (typed-ontology-class query API over A's data) and
// SC#4 (resolveEntities runs against A's adapter-fronted graph). Both
// require A's data materialised as KM-Core entities; this is the
// reprojection step.
//
// Algorithm (per 41-PATTERNS / D-47 / CF-D37 / CF-D38):
//   1. Validate options:
//        - `sources.sqlite` set ⇒ throw "not yet supported in Phase 41"
//        - `sources.jsonExports` missing ⇒ throw "required"
//        - `checkpointPath` containing `..` segments ⇒ throw
//   2. Read prior checkpoint (or null if none).
//   3. Build in-memory Map<sqliteId, EntityId> by iterating
//      store.iterate({}, { includeSuperseded: true }) and filtering on
//        entity.legacyId?.system === 'A'
//        && entity.metadata?.subsystem === 'online'
//      Key by TOP-LEVEL entity.legacyId.id (NOT the metadata bag's
//      copy — legacyId lives at the top level per CF-D37 / entity.ts:147).
//      This is the canonical idempotency-resolver scan.
//   4. Process source tables in order: observations → digests → insights.
//      The order matters because Digest→Observation and Insight→Digest
//      aggregation edges need their endpoints already present.
//      For each row:
//        a. Missing source file ⇒ push to warnings[], log stderr, treat
//           as empty (do NOT throw — operator may have only observations
//           on a fresh machine).
//        b. Resume cursor: if we're in the table the checkpoint last
//           recorded AND haven't passed lastProcessedSourceId yet, skip.
//        c. Idempotency: if row.id already present in the in-memory map,
//           skip (per-table skipped counter).
//        d. Map row → Entity via Plan 02 mapper.
//        e. Pre-stamp synthetic EntityProvenance via legacyProvenance
//           (mirrors backfill/index.ts:230-243 — trusted path requires
//           pre-stamping because skipOntologyCheck bypasses the D-30
//           strict-path provenance auto-assembly).
//        f. Mint a fresh EntityId via mintEntityId() and assign to the
//           stamped entity.
//        g. If dryRun ⇒ skip writes + checkpoint.
//           Else ⇒ store.putEntity(stamped, { skipOntologyCheck: true });
//           update the in-memory map so subsequent edges resolve.
//        h. For digest/insight rows: emit aggregation edges
//           (type: 'aggregates') to each referenced observationId /
//           digestId via the in-memory map. Orphan references push a
//           warning AND log stderr, do NOT throw. Before adding each
//           relation: findRelations({from, to, type:'aggregates'}) and
//           skip if any match (idempotent re-run).
//        i. Atomic checkpoint write after each successful row.
//
// Threats mitigated:
//   - T-41-04-01 (path-traversal): resolveCheckpointPath rejects `..`
//     segments BEFORE path.resolve() normalises them.
//   - T-41-04-03 (concurrent reproject corrupts checkpoint): atomic
//     temp-rename pattern (POSIX-atomic when src and dst share a
//     filesystem; same-directory placement guarantees this).
//   - T-41-04-04 (malformed source JSON): JSON.parse errors propagate
//     directly (do NOT swallow — operator wants to know). Missing files
//     produce warnings; orphan refs produce warnings; neither aborts.
//   - T-41-04-05 (DoS via huge source files): per-row write + atomic
//     checkpoint after EACH write (mirrors T-39-04-04 backfill
//     mitigation). Memory bound: in-memory legacyId Map + one row at a
//     time.
//   - T-41-04-06 (reproject opens A's SQLite for writing): sources.sqlite
//     throws immediately. Phase 41 ships JSON-exports path only;
//     SQLite is reserved for a future phase.
//   - T-41-04-07 (npm installs): no new dependencies; mintEntityId reuses
//     the existing helper.
//
// no-console-log: all diagnostics via process.stderr.write per project
// rule. Prefix: `[km-core/adapters/online]`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Entity,
  EntityProvenance,
  ProvenanceStamp,
  Relation,
} from '../../types/entity.js';
import type { EntityId } from '../../ids/branded.js';
import type { GraphKMStore } from '../../store/GraphKMStore.js';
import { mintEntityId } from '../../ids/mint.js';
import {
  mapObservationRow,
  mapDigestRow,
  mapInsightRow,
  type ObservationRow,
  type DigestRow,
  type InsightRow,
} from './mapper.js';
import {
  readReprojectCheckpoint,
  writeReprojectCheckpointAtomic,
  type ReprojectCheckpoint,
} from './checkpoint.js';

/** Default checkpoint path resolved against process.cwd(). */
const DEFAULT_CHECKPOINT_PATH = '.data/reproject-online-checkpoint.json';

/** Names of the JSON files inside `sources.jsonExports`. */
const SOURCE_FILES = {
  observations: 'observations.json',
  digests: 'digests.json',
  insights: 'insights.json',
} as const;

/**
 * Progress event emitted via `onProgress` callback for each phase /
 * row-batch. Optional — no-op if undefined.
 */
export interface ProgressEvent {
  phase: 'observations' | 'digests' | 'insights' | 'relations';
  processed: number;
  total: number;
}

/**
 * Sources discriminator. Per CONTEXT.md `<specifics>` both keys are
 * optional, but Phase 41 ships ONLY the `jsonExports` branch:
 *   - sources.sqlite set ⇒ throw "not yet supported in Phase 41"
 *   - sources.jsonExports omitted (or empty `sources: {}`) ⇒ throw "required"
 *   - sources.jsonExports set ⇒ JSON-exports path (Phase 41 surface).
 */
export interface ReprojectSources {
  sqlite?: string;
  jsonExports?: string;
}

/**
 * Options bag (Pattern S1 — CF-D14 options-object signature).
 *
 *   - `sources`: discriminator object. See `ReprojectSources`.
 *   - `legacyProvenance`: synthetic ProvenanceStamp to stamp onto every
 *     reprojected entity's metadata.provenance (createdBy +
 *     lastConfirmedBy). Reprojected entities have no native provenance
 *     (per 41-CONTEXT.md `<specifics>`) so the operator supplies one.
 *     Convention: `{ provider: 'reproject-online', model: 'phase-41-plan-04',
 *     runId, timestamp }`.
 *   - `dryRun`: when true, load + map + emit progress but write NEITHER
 *     entities NOR relations NOR checkpoint.
 *   - `checkpointPath`: default `.data/reproject-online-checkpoint.json`
 *     (resolved against process.cwd()). MUST NOT contain `..` segments.
 *   - `chunkSize`: reserved for future batching of the in-memory legacyId
 *     scan; currently unused (per-row writes already bound memory).
 *   - `onProgress`: optional callback invoked once per phase change and
 *     per row-batch within a phase.
 */
export interface ReprojectOptions {
  sources: ReprojectSources;
  legacyProvenance: ProvenanceStamp;
  dryRun?: boolean;
  checkpointPath?: string;
  chunkSize?: number;
  onProgress?: (e: ProgressEvent) => void;
}

/**
 * Result of a reproject run.
 *
 *   - `runId`: caller-supplied via `legacyProvenance.runId` OR generated
 *     from `randomUUID()` if the stamp didn't carry one. Used as the
 *     checkpoint's runId field.
 *   - `scanned` / `written` / `skipped`: per-table counters. `written`
 *     additionally counts `relations` (aggregation edges).
 *   - `warnings`: non-fatal events surfaced to the operator. Distinct
 *     from a fatal error channel — warnings let operators see missing
 *     source files and orphan-edge references early. Strings are of the
 *     form `missing-source-file: <path>` and
 *     `orphan-edge-ref: <type> <id> references unknown <type> <id>`.
 *   - `dryRun`: echo of the input option.
 */
export interface ReprojectResult {
  runId: string;
  scanned: {
    observations: number;
    digests: number;
    insights: number;
  };
  written: {
    observations: number;
    digests: number;
    insights: number;
    relations: number;
  };
  skipped: {
    observations: number;
    digests: number;
    insights: number;
  };
  warnings: string[];
  dryRun: boolean;
}

/**
 * Resolve + validate the checkpoint path. Verbatim-ported from
 * `backfill/index.ts:130-138` (rename function + error prefix).
 *
 * Rejects any raw path containing `..` segments (T-41-04-01 mitigation
 * — `path.resolve()` would normalise them away, silently hiding operator
 * intent errors). Returns the resolved absolute path so all downstream
 * filesystem operations are on a canonical form.
 */
function resolveCheckpointPath(cp?: string): string {
  const raw = cp ?? DEFAULT_CHECKPOINT_PATH;
  if (raw.split(path.sep).includes('..') || raw.split('/').includes('..')) {
    throw new Error(
      `reprojectFromOnlineStore: checkpointPath must not contain '..' segments: ${raw}`,
    );
  }
  return path.resolve(raw);
}

/**
 * Read a source-table JSON file. Returns `[]` and pushes a warning if
 * the file is missing (operator may have only observations on a fresh
 * machine — explicitly tolerated per the plan's `<behavior>` block).
 * JSON.parse errors propagate verbatim per T-41-04-04 (malformed source
 * is operator-visible, not silently skipped).
 */
function readSourceTable<T>(
  jsonExportsDir: string,
  filename: string,
  warnings: string[],
): T[] {
  const filePath = path.join(jsonExportsDir, filename);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      warnings.push(`missing-source-file: ${filePath}`);
      process.stderr.write(
        `[km-core/adapters/online] source file ${filePath} not found; treating as empty\n`,
      );
      return [];
    }
    throw err;
  }
  return JSON.parse(raw) as T[];
}

/**
 * Build the in-memory `Map<sqliteId, EntityId>` of A-side online-subsystem
 * entities already present in the store. Used for two things:
 *   (a) idempotency — skip rows whose id already maps to a stored entity;
 *   (b) edge resolution — translate row.observationIds[] / row.digestIds[]
 *       references onto the corresponding survivor EntityId.
 *
 * Filter (CF-D37 canonical pattern):
 *   entity.legacyId?.system === 'A' && entity.metadata?.subsystem === 'online'
 *
 * Key by TOP-LEVEL `entity.legacyId.id` (NOT the metadata-bag copy).
 */
async function buildLegacyIdMap(
  store: GraphKMStore,
): Promise<Map<string, EntityId>> {
  const map = new Map<string, EntityId>();
  for await (const e of store.iterate({}, { includeSuperseded: true })) {
    if (e.legacyId?.system === 'A' && e.metadata?.subsystem === 'online') {
      map.set(e.legacyId.id, e.id);
    }
  }
  return map;
}

/**
 * Stamp the synthetic EntityProvenance + mint an EntityId on a mapper-
 * produced Entity. Mirrors backfill/index.ts:230-245 — trusted-path
 * pre-stamping is mandatory because `skipOntologyCheck: true` bypasses
 * the D-30 / D-32 auto-assembly.
 */
function preStamp(
  raw: Entity,
  legacyProvenance: ProvenanceStamp,
): Entity & { id: EntityId } {
  const syntheticProv: EntityProvenance = {
    createdBy: legacyProvenance,
    lastConfirmedBy: legacyProvenance,
    confirmationCount: 1,
  };
  return {
    ...raw,
    id: mintEntityId(),
    metadata: {
      ...(raw.metadata ?? {}),
      provenance: syntheticProv,
    },
  };
}

/**
 * Build a fresh checkpoint snapshot to persist after each row write.
 */
function buildCheckpointSnapshot(
  runId: string,
  result: ReprojectResult,
  lastProcessedSourceId: string,
  lastProcessedTable: 'observations' | 'digests' | 'insights',
): ReprojectCheckpoint {
  return {
    version: 1,
    runId,
    lastProcessedSourceId,
    lastProcessedTable,
    scanned: { ...result.scanned },
    written: { ...result.written },
    skipped: { ...result.skipped },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Run the reprojection. See module-level JSDoc for the full algorithm.
 *
 * Idempotent (re-runs collapse to the same final entity count via the
 * top-level `legacyId` resolver scan). Resumable (atomic checkpoint after
 * each row write — crash + restart picks up from `lastProcessedSourceId`
 * within `lastProcessedTable`). Read-only against A's data (the function
 * NEVER opens A's `observations.db` for writing; `sources.sqlite` is
 * rejected as not-yet-supported).
 */
export async function reprojectFromOnlineStore(
  store: GraphKMStore,
  options: ReprojectOptions,
): Promise<ReprojectResult> {
  // ── Step 1: validate options ────────────────────────────────────────
  if (options.sources.sqlite !== undefined) {
    throw new Error(
      'reprojectFromOnlineStore: sources.sqlite is not yet supported in Phase 41; use sources.jsonExports',
    );
  }
  if (
    options.sources.jsonExports === undefined ||
    options.sources.jsonExports === null ||
    options.sources.jsonExports === ''
  ) {
    throw new Error(
      'reprojectFromOnlineStore: sources.jsonExports is required',
    );
  }

  const jsonExportsDir = options.sources.jsonExports;
  const checkpointPath = resolveCheckpointPath(options.checkpointPath);
  const dryRun = options.dryRun === true;
  const runId = options.legacyProvenance.runId || randomUUID();
  const onProgress = options.onProgress;

  const result: ReprojectResult = {
    runId,
    scanned: { observations: 0, digests: 0, insights: 0 },
    written: { observations: 0, digests: 0, insights: 0, relations: 0 },
    skipped: { observations: 0, digests: 0, insights: 0 },
    warnings: [],
    dryRun,
  };

  // ── Step 2: read prior checkpoint ──────────────────────────────────
  const prior = await readReprojectCheckpoint(checkpointPath);
  // Resume cursor is only honoured when the prior checkpoint's runId
  // matches the current run (defensive against running a new reproject
  // against a stale checkpoint left behind by an aborted earlier run).
  const resumeActive = prior !== null && prior.runId === runId;
  let resumeTable: 'observations' | 'digests' | 'insights' | null = resumeActive
    ? prior!.lastProcessedTable
    : null;
  let resumeCursor: string | null = resumeActive
    ? prior!.lastProcessedSourceId
    : null;

  // ── Step 3: build idempotency map (top-level legacyId scan) ────────
  const legacyMap = await buildLegacyIdMap(store);

  // Helper: process one row through write + checkpoint. Returns the
  // stamped entity's EntityId (or null if skipped). `tableName` is the
  // active table for the checkpoint snapshot.
  async function processEntityRow<R extends { id: string }>(
    row: R,
    table: 'observations' | 'digests' | 'insights',
    mapper: (r: R) => Entity,
  ): Promise<EntityId | null> {
    // Idempotency: row already projected?
    if (legacyMap.has(row.id)) {
      result.skipped[table] += 1;
      return null;
    }
    // Resume cursor: if we're in the recorded table AND haven't yet
    // passed the cursor, treat as skipped. The cursor row itself was
    // already processed before the crash, so include-and-skip is
    // correct.
    if (resumeTable === table && resumeCursor !== null) {
      result.skipped[table] += 1;
      if (row.id === resumeCursor) {
        // Cursor hit — clear it so subsequent rows in this table are
        // processed.
        resumeCursor = null;
      }
      return null;
    }
    const mapped = mapper(row);
    if (dryRun) {
      process.stderr.write(
        `[km-core/adapters/online] dry-run: would project ${table} row ${row.id}\n`,
      );
      // No write, no checkpoint — but emit progress.
      onProgress?.({
        phase: table,
        processed: result.scanned[table],
        total: result.scanned[table],
      });
      return null;
    }
    const stamped = preStamp(mapped, options.legacyProvenance);
    await store.putEntity(stamped, { skipOntologyCheck: true });
    legacyMap.set(row.id, stamped.id);
    result.written[table] += 1;
    await writeReprojectCheckpointAtomic(
      checkpointPath,
      buildCheckpointSnapshot(runId, result, row.id, table),
    );
    onProgress?.({
      phase: table,
      processed: result.written[table],
      total: result.scanned[table],
    });
    return stamped.id;
  }

  // Helper: add a single aggregation edge with already-exists check.
  async function addAggregatesEdge(
    fromId: EntityId,
    toId: EntityId,
  ): Promise<boolean> {
    // already-exists check for idempotent re-runs
    const existing = await store.findRelations({
      from: fromId,
      to: toId,
      type: 'aggregates',
    });
    if (existing.length > 0) return false;
    const relation: Relation = {
      type: 'aggregates',
      from: fromId,
      to: toId,
      createdAt: new Date().toISOString(),
    };
    await store.addRelation(relation);
    result.written.relations += 1;
    return true;
  }

  // ── Step 4a: observations table ─────────────────────────────────────
  const observations = readSourceTable<ObservationRow>(
    jsonExportsDir,
    SOURCE_FILES.observations,
    result.warnings,
  );
  // If we're resuming and the recorded table comes after observations,
  // skip the observations table's resume gate entirely (resumeTable
  // semantics: only the recorded table's rows are gated).
  if (resumeTable !== null && resumeTable !== 'observations') {
    // We never gate observations — already past this table on resume.
  }
  for (const row of observations) {
    result.scanned.observations += 1;
    await processEntityRow(row, 'observations', mapObservationRow);
  }
  // After finishing observations, if the resume cursor was in this table
  // and we still didn't hit it, clear it (defensive — source data may
  // have changed across runs).
  if (resumeTable === 'observations') {
    resumeTable = null;
    resumeCursor = null;
  }
  onProgress?.({
    phase: 'observations',
    processed: result.written.observations,
    total: result.scanned.observations,
  });

  // ── Step 4b: digests table ──────────────────────────────────────────
  const digests = readSourceTable<DigestRow>(
    jsonExportsDir,
    SOURCE_FILES.digests,
    result.warnings,
  );
  for (const row of digests) {
    result.scanned.digests += 1;
    const digestEntityId = await processEntityRow(
      row,
      'digests',
      mapDigestRow,
    );
    // Aggregation edges: Digest → Observation. Look up endpoint via the
    // in-memory map (populated from the store iteration + any
    // just-written rows). Orphan refs push warnings AND log stderr.
    if (!dryRun) {
      // For idempotent re-runs the digest was already in legacyMap; we
      // still need to walk the edges in case prior runs didn't finish
      // them. Resolve the digest's EntityId either way.
      const resolvedDigestId =
        digestEntityId ?? legacyMap.get(row.id) ?? null;
      if (resolvedDigestId !== null) {
        for (const observationId of row.observationIds ?? []) {
          const observationEntityId = legacyMap.get(observationId);
          if (observationEntityId === undefined) {
            const msg = `orphan-edge-ref: digest ${row.id} references unknown observation ${observationId}`;
            result.warnings.push(msg);
            process.stderr.write(
              `[km-core/adapters/online] digest ${row.id} references unknown observation ${observationId}; skipping edge\n`,
            );
            continue;
          }
          await addAggregatesEdge(resolvedDigestId, observationEntityId);
        }
      }
    }
  }
  if (resumeTable === 'digests') {
    resumeTable = null;
    resumeCursor = null;
  }
  onProgress?.({
    phase: 'digests',
    processed: result.written.digests,
    total: result.scanned.digests,
  });

  // ── Step 4c: insights table ─────────────────────────────────────────
  const insights = readSourceTable<InsightRow>(
    jsonExportsDir,
    SOURCE_FILES.insights,
    result.warnings,
  );
  for (const row of insights) {
    result.scanned.insights += 1;
    const insightEntityId = await processEntityRow(
      row,
      'insights',
      mapInsightRow,
    );
    // Aggregation edges: Insight → Digest.
    if (!dryRun) {
      const resolvedInsightId =
        insightEntityId ?? legacyMap.get(row.id) ?? null;
      if (resolvedInsightId !== null) {
        for (const digestId of row.digestIds ?? []) {
          const digestEntityId = legacyMap.get(digestId);
          if (digestEntityId === undefined) {
            const msg = `orphan-edge-ref: insight ${row.id} references unknown digest ${digestId}`;
            result.warnings.push(msg);
            process.stderr.write(
              `[km-core/adapters/online] insight ${row.id} references unknown digest ${digestId}; skipping edge\n`,
            );
            continue;
          }
          await addAggregatesEdge(resolvedInsightId, digestEntityId);
        }
      }
    }
  }
  if (resumeTable === 'insights') {
    resumeTable = null;
    resumeCursor = null;
  }
  onProgress?.({
    phase: 'insights',
    processed: result.written.insights,
    total: result.scanned.insights,
  });

  return result;
}

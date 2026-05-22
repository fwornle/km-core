// Phase 41 Plan 04 (INT-01): atomic checkpoint persistence for the
// reprojectFromOnlineStore resumability contract (CF-D38).
//
// LIFTED from `src/backfill/checkpoint.ts` (the canonical analog — also
// lifted from Phase 37 Exporter `writeAtomic`; CF-D29 temp+rename idiom).
// We INTENTIONALLY copy the patterns rather than `import` from the backfill
// module so the adapter has zero coupling to the backfill subsystem
// (per 41-PLAN.md Task 1 action: "do NOT import from there — copy the
// patterns with rename").
//
// Renames vs the backfill checkpoint:
//   - Checkpoint                       → ReprojectCheckpoint
//   - writeCheckpointAtomic            → writeReprojectCheckpointAtomic
//   - readCheckpoint                   → readReprojectCheckpoint
//   - lastStampedId: string | null     → lastProcessedSourceId: string
//   + lastProcessedTable: 'observations' | 'digests' | 'insights'
//   + Per-table structured scanned/written/skipped counters (per 41-PLAN
//     Task 1 behavior block).
//
// Atomic-rename guarantee:
//   - The temp file is constructed as `${checkpointPath}.tmp.${pid}.${ts}`,
//     so `path.dirname(tempPath) === path.dirname(checkpointPath)`.
//   - `fs.promises.rename` is atomic on POSIX only when source and
//     destination live on the same filesystem; same-directory placement
//     guarantees this. (CF-D38 T-39-04-02 mitigation, ported verbatim.)
//
// WR-03 (Phase 39 REVIEW): `JSON.parse` runs OUTSIDE the I/O try/catch so
// `SyntaxError` surfaces directly to the operator (NOT mis-coded as an
// I/O error). Version-mismatch throws with the path in the message so the
// operator can delete the file to restart cleanly.

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Persisted state of an in-progress or completed reproject run.
 *
 * `version` is a structural version marker (bump on shape changes — WR-03
 * read-side guard throws on mismatch).
 *
 * `lastProcessedSourceId` is the SOURCE-ROW id (e.g. an A-side SQLite id
 * stamped via `entity.legacyId.id`) of the most-recently processed row
 * within `lastProcessedTable`. On resume, the per-row loop within that
 * table skips up to and INCLUDING this id (the idempotency scan over
 * top-level `entity.legacyId` is the safety net if iteration order shifts
 * across runs).
 *
 * `lastProcessedTable` identifies which source table the cursor was
 * processing when the checkpoint last wrote. Tables that come AFTER this
 * one in the canonical processing order (observations → digests →
 * insights — see CONTEXT.md `<specifics>`) are processed from scratch on
 * resume.
 *
 * The structured counters split scanned/written/skipped by source table so
 * an operator inspecting a checkpoint file can see exactly where progress
 * stopped — useful for the "did I finish digests before crashing?" question.
 * `written.relations` counts emitted aggregation edges (Digest→Observation
 * and Insight→Digest).
 */
export interface ReprojectCheckpoint {
  version: 1;
  runId: string;
  lastProcessedSourceId: string;
  lastProcessedTable: 'observations' | 'digests' | 'insights';
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
  updatedAt: string;
}

/**
 * Atomic write: writes to `<path>.tmp.<pid>.<ts>` in the SAME directory,
 * then `fs.promises.rename` to the destination. Rename is atomic on POSIX
 * when src and dst share a filesystem (which they do because the temp file
 * lives in the destination's parent directory).
 *
 * `mkdirSync({ recursive: true })` is called first so the caller doesn't
 * have to pre-create the directory (the default
 * `.data/reproject-online-checkpoint.json` path lives in a project-local
 * `.data/` directory that may not yet exist on a fresh machine).
 */
export async function writeReprojectCheckpointAtomic(
  checkpointPath: string,
  data: ReprojectCheckpoint,
): Promise<void> {
  const dir = path.dirname(checkpointPath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${checkpointPath}.tmp.${process.pid}.${Date.now()}`;
  await fs.promises.writeFile(
    tempPath,
    JSON.stringify(data, null, 2),
    'utf-8',
  );
  await fs.promises.rename(tempPath, checkpointPath); // atomic on POSIX
}

/**
 * Returns `null` if the file does not exist (fresh run); throws on any
 * other I/O error AND on `JSON.parse` SyntaxError AND on a version
 * mismatch.
 *
 * Callers MUST treat a `null` return as "no prior state — start from the
 * beginning"; treating it as an error would break the first-run path (no
 * checkpoint yet exists).
 *
 * WR-03 (Phase 39 REVIEW): `JSON.parse` is INTENTIONALLY outside the I/O
 * try/catch so SyntaxError propagates directly to the operator. Mis-coding
 * a parse failure as an I/O error would silently hide checkpoint
 * corruption.
 *
 * Version-mismatch throws an actionable error including the path so the
 * operator can delete the file to start fresh. Without this, a checkpoint
 * persisted under a future schema version would be silently accepted and
 * produce wrong resume state (e.g. missing fields read as `undefined`,
 * downstream string-comparisons never matching, infinite re-scan loops).
 */
export async function readReprojectCheckpoint(
  checkpointPath: string,
): Promise<ReprojectCheckpoint | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(checkpointPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err; // surface real I/O errors
  }
  // JSON.parse INTENTIONALLY outside the I/O catch (WR-03): SyntaxError
  // surfaces directly so operator sees the real problem (file corruption)
  // rather than a mis-coded I/O error.
  const cp = JSON.parse(raw) as ReprojectCheckpoint;
  if (cp.version !== 1) {
    throw new Error(
      `reproject checkpoint version mismatch: expected 1, got ${String(cp.version)}. Delete ${checkpointPath} to start fresh.`,
    );
  }
  return cp;
}

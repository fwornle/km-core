// Phase 39 (DATA-01/DATA-02): atomic checkpoint persistence for the
// backfill resumability contract (D-38). LIFTED from Phase 37 Exporter
// `writeAtomic` (CF-D29 temp+rename idiom — `src/store/exporter.ts:216-227`).
// Module-scope free functions; not a class — D-36 says km-core is
// library-only and the checkpoint helper has zero state of its own.
//
// Atomic-rename guarantee:
//   - The temp file is constructed as `${checkpointPath}.tmp.${pid}.${ts}`,
//     so `path.dirname(tempPath) === path.dirname(checkpointPath)`.
//   - `fs.promises.rename` is atomic on POSIX only when source and
//     destination live on the same filesystem; same-directory placement
//     guarantees this.
//   - threat T-39-04-02 (atomic-rename race) is mitigated by this
//     construction.

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Persisted state of an in-progress or completed backfill run.
 *
 * `version` is a structural version marker (D-38) — bump on shape changes.
 * `lastStampedId` is the id of the most-recently stamped entity in
 * iteration order; on resume, the per-entity loop skips up to and
 * including this id (D-37 idempotency closes the gap if iteration order
 * shifts across runs, since the per-entity validFrom check catches
 * already-stamped entities regardless of cursor position).
 */
export interface Checkpoint {
  version: 1;
  runId: string;
  lastStampedId: string | null;
  scanned: number;
  stamped: number;
  skipped: number;
  updatedAt: string;
}

/**
 * Atomic write: writes to `<path>.tmp.<pid>.<ts>` in the SAME directory,
 * then `rename` to the destination. Rename is atomic on POSIX when src
 * and dst share a filesystem (which they do because the temp file lives
 * in the destination's parent directory).
 *
 * Lifted from Phase 37 `Exporter.writeAtomic` (`src/store/exporter.ts:216-227`)
 * with two deltas: (a) module-scope free function not a class private
 * method; (b) `mkdirSync({ recursive: true })` is called first so the
 * caller doesn't have to pre-create the directory (the default
 * `.data/backfill-checkpoint.json` path lives in a project-local
 * `.data/` directory that may not yet exist).
 */
export async function writeCheckpointAtomic(
  checkpointPath: string,
  data: Checkpoint,
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
 * other I/O error (permission denied, malformed JSON, etc.).
 *
 * Callers MUST treat a `null` return as "no prior state — start from
 * the beginning"; treating it as an error would break the first-run
 * path (no checkpoint yet exists).
 */
export async function readCheckpoint(
  checkpointPath: string,
): Promise<Checkpoint | null> {
  try {
    const raw = await fs.promises.readFile(checkpointPath, 'utf-8');
    return JSON.parse(raw) as Checkpoint;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err; // surface real I/O errors
  }
}

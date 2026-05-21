// Phase 39 (DATA-01/DATA-02): backfillEntityDataModel library function.
//
// Per-system migration scripts (A in `coding/scripts/`, B in
// `mcp-server-semantic-analysis/scripts/`, C in `rapid-automations/scripts/`)
// will construct their own `GraphKMStore` and call this. km-core ships
// the algorithm; consumers wire their store + resolver + synthetic
// provenance (D-36 — library-only, no bin/).
//
// Algorithm (D-37 + D-38):
//   1. Read prior checkpoint (or null if none).
//   2. Iterate the store with `includeSuperseded:true` so superseded
//      entities are still visible — they may also be missing `validFrom`
//      and need stamping.
//   3. For each entity:
//        a. If we haven't yet passed the prior checkpoint's lastStampedId,
//           count as skipped and continue.
//        b. If `entity.validFrom` is already set, count as skipped and
//           continue (D-37 idempotency — re-runs are safe).
//        c. Otherwise call `options.resolver(entity)` to compute the
//           new `validFrom` + optional `legacyId`.
//        d. If `dryRun`, log to stderr and continue (no store write,
//           no checkpoint write).
//        e. Pre-stamp `validFrom` + `legacyId` + a synthetic
//           `EntityProvenance` on the entity object (the trusted path
//           passes the entity through verbatim — see Plan 01 D-30 and
//           39-PATTERNS §S2).
//        f. `store.putEntity(stamped, { skipOntologyCheck: true })`.
//        g. Atomic checkpoint write recording the new `lastStampedId`.
//
// Threats mitigated:
//   - T-39-04-01 (path-traversal): `resolveCheckpointPath` rejects raw
//     paths containing `..` segments BEFORE `path.resolve()` normalizes
//     them.
//   - T-39-04-02 (atomic-rename race): the temp file in `checkpoint.ts`
//     lives in the same directory as the destination, guaranteeing
//     same-filesystem rename.
//   - T-39-04-04 (DoS via memory pressure on 100K+ stores): per-entity
//     write + atomic checkpoint after each bounds memory; iteration is
//     lazy via `store.iterate()`.

import * as path from 'node:path';
import type {
  Entity,
  ProvenanceStamp,
  EntityProvenance,
} from '../types/entity.js';
import type { GraphKMStore } from '../store/GraphKMStore.js';
import {
  writeCheckpointAtomic,
  readCheckpoint,
  type Checkpoint,
} from './checkpoint.js';

/**
 * Caller-supplied closure that maps a legacy entity to its computed
 * `validFrom` (ISO timestamp) and optional `legacyId` origin bridge.
 *
 * A's resolver typically returns `{ validFrom: entity.createdAt }` and
 * fills `legacyId` from A's SQLite native id. B's resolver returns
 * `{ validFrom: metadata.firstSeenAt ?? entity.createdAt }` with
 * `legacyId` from B's persistence-agent native id. C's resolver is
 * defined when Phase 43 INT-03 lands.
 *
 * Backfill invokes the resolver ONLY for entities lacking `validFrom`
 * (D-37 idempotency).
 */
export interface BackfillResolver {
  (entity: Entity): {
    validFrom: string;
    legacyId?: { system: 'A' | 'B' | 'C'; id: string };
  };
}

/**
 * Options bag (Pattern S1 — CF-D14 options-object signature).
 *
 *   - `resolver`: maps a legacy entity to its new `validFrom` + optional
 *     `legacyId`. Invoked only for entities missing `validFrom`.
 *   - `legacyProvenance`: synthetic `ProvenanceStamp` to stamp onto every
 *     backfilled entity's `metadata.provenance` (createdBy +
 *     lastConfirmedBy). Convention: `provider: 'backfill'` so downstream
 *     observability can filter backfilled-vs-live writes.
 *   - `checkpointPath`: default `.data/backfill-checkpoint.json`. MUST
 *     NOT contain `..` segments (T-39-04-01 mitigation).
 *   - `dryRun`: when true, logs intent to stderr but writes nothing.
 */
export interface BackfillOptions {
  resolver: BackfillResolver;
  legacyProvenance: ProvenanceStamp;
  checkpointPath?: string; // default '.data/backfill-checkpoint.json'
  dryRun?: boolean; // default false
}

/**
 * Result of a backfill run.
 *
 *   - `scanned`: per-run total entities seen in iteration (including
 *     ones skipped because they already had `validFrom` or were already
 *     past the checkpoint cursor on resume). Always a fresh count for
 *     this invocation (not cumulative across resumed runs).
 *   - `stamped`: cumulative count of entities for which `store.putEntity`
 *     was called — carries forward from the prior checkpoint so a
 *     100K-entity backfill interrupted 3 times still reports
 *     `stamped: 100000` at the end. In `dryRun:true` mode this is always
 *     0 — dry-run reports intent only.
 *   - `skipped`: per-run count of entities that were not stamped because
 *     they already had `validFrom` (D-37 idempotency skip) or were
 *     skipped by the resume cursor. Always a fresh count for this
 *     invocation (not cumulative across resumed runs) — fixes CR-02
 *     double-counting on resume. On a dry-run, `skipped` counts only
 *     entities that already had `validFrom`; dry-run does NOT count
 *     would-stamp entities as skipped.
 */
export interface BackfillResult {
  scanned: number;
  stamped: number;
  skipped: number;
}

const DEFAULT_CHECKPOINT_PATH = '.data/backfill-checkpoint.json';

/**
 * Resolve + validate the checkpoint path.
 *
 * Rejects any raw path containing `..` segments (T-39-04-01 mitigation
 * — `path.resolve()` would normalize them away, which silently hides
 * operator intent errors). Returns the resolved absolute path so all
 * downstream filesystem operations are on a canonical form.
 */
function resolveCheckpointPath(cp?: string): string {
  const raw = cp ?? DEFAULT_CHECKPOINT_PATH;
  if (raw.split(path.sep).includes('..') || raw.split('/').includes('..')) {
    throw new Error(
      `backfillEntityDataModel: checkpointPath must not contain '..' segments: ${raw}`,
    );
  }
  return path.resolve(raw);
}

/**
 * Iterate the store, identify legacy entities (missing `validFrom`),
 * stamp them via the caller-supplied resolver + synthetic provenance,
 * write each via `store.putEntity({ skipOntologyCheck: true })`, and
 * atomically update the checkpoint after each write.
 *
 * Idempotent (D-37): re-running on a partially-stamped store skips
 * entities that already have `validFrom`. Resumable (D-38): on crash,
 * the checkpoint file records `lastStampedId`; subsequent runs read
 * the checkpoint and skip up to that id.
 *
 * CRITICAL — trusted-path pre-stamp: Plan 01's strict path requires
 * `opts.provenance`. Backfill uses `{ skipOntologyCheck: true }` (no
 * provenance opt), which takes the trusted path that passes the entity
 * through verbatim. So backfill MUST set `entity.metadata.provenance`
 * explicitly BEFORE calling `putEntity` — see 39-PATTERNS lines 247-253.
 */
export async function backfillEntityDataModel(
  store: GraphKMStore,
  options: BackfillOptions,
): Promise<BackfillResult> {
  const checkpointPath = resolveCheckpointPath(options.checkpointPath);
  const dryRun = options.dryRun === true;

  const prior = await readCheckpoint(checkpointPath);
  let lastStampedId: string | null = prior?.lastStampedId ?? null;
  let stamped = prior?.stamped ?? 0;
  // CR-02 fix: `skipped` is a PER-RUN counter — it does NOT carry forward
  // from the prior checkpoint. The previous behavior (`prior?.skipped ?? 0`)
  // double-counted entities skipped on the original run AND skipped again
  // by the resume cursor on the subsequent run, over-reporting the true
  // count for any resumed invocation. Only `stamped` carries forward
  // (cumulative across resumed runs per BackfillResult JSDoc — "a 100K
  // entity backfill interrupted 3 times still reports stamped: 100000").
  // See REVIEW.md CR-02 and IN-02 in `.planning/phases/39-entity-data-model/39-REVIEW.md`.
  let skipped = 0;
  let scanned = 0;
  // When `lastStampedId` is null we're at the start (no prior progress)
  // or we just finished resume-skipping. The `sawCheckpointCursor` flag
  // flips to true once we encounter the prior cursor entity OR if there
  // is no cursor to start with.
  let sawCheckpointCursor = lastStampedId === null;

  // includeSuperseded:true so the backfill sees ALL entities — including
  // any with closed `validUntil` that happen to lack `validFrom` for any
  // reason (the active-only default filter would silently skip them and
  // backfill would never stamp them).
  for await (const entity of store.iterate({}, { includeSuperseded: true })) {
    scanned += 1;

    // Resume cursor — skip entries that come before lastStampedId in
    // iteration order. (Graphology v0.26 `graph.nodes()` yields in
    // insertion order; this is stable across runs of the same process.
    // For cross-process resume, the D-37 idempotency check below acts
    // as a safety net — already-stamped entities are skipped regardless
    // of cursor position.)
    if (!sawCheckpointCursor) {
      if (String(entity.id) === lastStampedId) {
        sawCheckpointCursor = true;
      }
      // Either way the entity was already handled on a prior run.
      skipped += 1;
      continue;
    }

    // D-37 idempotency: entities with `validFrom` already set are
    // skipped without invoking the resolver. Safe to re-run after a
    // partial backfill.
    if (entity.validFrom !== undefined) {
      skipped += 1;
      continue;
    }

    const resolved = options.resolver(entity);

    if (dryRun) {
      process.stderr.write(
        `[km-core/backfill] dry-run: would stamp entity ${String(entity.id)} with validFrom=${resolved.validFrom}\n`,
      );
      // dry-run does NOT count as stamped AND does NOT write the
      // checkpoint. Result reports `stamped: 0` and only counts as
      // skipped the entities that genuinely already had `validFrom`
      // (per Behavior 2 / RESEARCH lines 367-368 contract).
      continue;
    }

    // Pre-stamp `validFrom` + `legacyId` + synthetic `EntityProvenance`
    // on the entity object so the trusted `putEntity` path passes them
    // through verbatim. The trusted path skips BOTH the D-30 throw AND
    // the auto provenance assembly (Plan 01 contract; 39-PATTERNS §S2).
    const syntheticProv: EntityProvenance = {
      createdBy: options.legacyProvenance,
      lastConfirmedBy: options.legacyProvenance,
      confirmationCount: 1,
    };
    const stampedEntity: Entity = {
      ...entity,
      validFrom: resolved.validFrom,
      legacyId: resolved.legacyId ?? entity.legacyId,
      metadata: {
        ...(entity.metadata ?? {}),
        provenance: syntheticProv,
      },
    };

    await store.putEntity(stampedEntity, { skipOntologyCheck: true });
    stamped += 1;
    lastStampedId = String(entity.id);

    const cp: Checkpoint = {
      version: 1,
      runId: options.legacyProvenance.runId,
      lastStampedId,
      scanned,
      stamped,
      skipped,
      updatedAt: new Date().toISOString(),
    };
    await writeCheckpointAtomic(checkpointPath, cp);
  }

  return { scanned, stamped, skipped };
}

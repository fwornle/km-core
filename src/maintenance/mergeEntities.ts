// Phase 41 Plan 05 (PIPE-02): atomic `mergeEntities` primitive.
//
// Collapses N duplicate entities into a survivor in a single atomic
// `store.batch([...])` call (CF-D17). This is the canonical "merge two
// entities + their graph context" op for ALL THREE systems
// (A in Phase 41, B in Phase 42, C in Phase 43 — D-50a). Phase 41 lands
// the primitive; Phase 42 + 43 delete their local `mergeEntityGroup`
// implementations in favor of this primitive.
//
// Composition (per 41-PATTERNS.md):
//   1. D-33 supersession-closure atomic-two-write pattern (lifted from
//      GraphKMStore.ts:474-477) — close each duplicate's `validUntil` +
//      add forward SUPERSEDED_BY edge.
//   2. `mergeDescriptionSegment` (CF-D39 / src/segments/merge.ts) — fold
//      each duplicate's descriptionSegments[] into the survivor.
//   3. OKM `migrateEdges` pattern (deduplicator.ts:910-933) — rewire
//      each duplicate's incoming/outgoing edges onto the survivor,
//      preserving edge.type + edge.metadata verbatim, dropping self-loops
//      after rewire.
//
// Edge-enumeration dedup gotcha (catches a real bug):
//   `store.findRelations({ from: dup.id })` and `store.findRelations({ to:
//   dup.id })` BOTH return any self-loop edge where `from === to === dup.id`.
//   Without an identity-key dedupe (`from|to|type|createdAt`), the same
//   self-loop would be counted twice in `edgesRewired` AND emit two
//   `removeRelation` BatchOps (the second of which is a silent no-op in
//   batch Phase 2 since the edge is already gone). Dedupe via `Set<string>`
//   before building BatchOps. Test K (Task 2) pins this path.
//
// WR-02 single-successor enforcement (mirrors GraphKMStore.ts:440-450):
//   Pre-flight check rejects merges where ANY duplicate already has a
//   SUPERSEDED_BY out-edge. The error message text is intentionally
//   identical to the store's write-time check so consumers can pattern-match
//   on one error string regardless of which entry point raised it.
//
// CR-01 per-op `skipOntologyCheck: true`:
//   Every `putEntity` BatchOp in the merge carries
//   `skipOntologyCheck: true`. This is mandatory because:
//     - The trusted path is the only path that lets us pre-stamp
//       `EntityProvenance` (the strict path's D-30 throw would otherwise
//       fire on the closed-duplicate write — duplicates already have
//       provenance from their own creation; we don't want to overwrite it).
//     - Reprojected entities (Phase 41 INT-01 + future phases) may carry
//       legacy non-v7 ids that would fail `parseEntityId` on the strict
//       path. See REVIEW-FIX.md CR-01.
//
// no-console-log: all diagnostics via `process.stderr.write` per project
// rule. Prefix: `[km-core/maintenance]`.

import type { Entity, Relation, ProvenanceStamp } from '../types/entity.js';
import type { EntityId } from '../ids/branded.js';
import type { GraphKMStore } from '../store/GraphKMStore.js';
import type { BatchOp } from '../store/types.js';
import { mergeDescriptionSegment } from '../segments/merge.js';

/**
 * Options bag for `mergeEntities`. Options-object signature per CF-D14.
 */
export interface MergeOptions {
  /**
   * ProvenanceStamp identifying the caller (e.g.
   * `{ provider: 'resolveEntities', model: 'phase-41', runId, timestamp }`).
   * Stamped onto the survivor's `metadata.provenance.lastConfirmedBy` and
   * onto each appended `resolutionHistory` record. mergeEntities NEVER
   * mints a stamp on its own (CF-D30 trust source = caller).
   */
  provenance: ProvenanceStamp;
  /**
   * When `true` (default), each duplicate's
   * `metadata.descriptionSegments[]` is folded into the survivor via
   * `mergeDescriptionSegment` (CF-D39). When `false`, segments are
   * not merged. Useful for callers that already manage their own
   * description-segment fan-in.
   */
  mergeSegments?: boolean;
  /** Optional human-readable reason; appended to each resolutionHistory record. */
  reason?: string;
}

/**
 * Result returned by `mergeEntities` on success.
 */
export interface MergeResult {
  survivorId: EntityId;
  duplicateIds: EntityId[];
  /**
   * Count of edges rewired from duplicates onto the survivor. Excludes
   * the SUPERSEDED_BY edges added in step (b). Self-loops dropped on
   * rewire are NOT counted (they have no replacement edge — counting
   * them would mis-report what landed in the graph).
   */
  edgesRewired: number;
  /** Total segments folded across all duplicates (sum of duplicate.descriptionSegments[] lengths). */
  segmentsMerged: number;
  /** ISO timestamp stamped on every closed-duplicate's `validUntil` AND every SUPERSEDED_BY edge's `createdAt`. */
  oldValidUntil: string;
  /** Wall-clock ms from entry to return. */
  durationMs: number;
}

/** Hash key for edge-identity dedup (from|to|type|createdAt). */
function edgeIdentityKey(r: Relation): string {
  return `${String(r.from)}|${String(r.to)}|${r.type}|${r.createdAt ?? ''}`;
}

/**
 * Atomically merge N duplicate entities into a survivor.
 *
 * D-50 four-step primitive (single `store.batch([...])` covers all ops):
 *   1. Close each duplicate's `validUntil` (D-33 supersession closure).
 *   2. Add forward SUPERSEDED_BY edge from each duplicate to the survivor
 *      (D-33 reverse-walk index).
 *   3. Rewire each duplicate's in/out edges onto the survivor, preserving
 *      `type` + `metadata` verbatim. Self-loops after rewire are removed
 *      without a replacement.
 *   4. Bump survivor's `confirmationCount` + update `lastConfirmedBy` +
 *      append one `resolutionHistory` record per duplicate.
 *
 * D-50a future-reuse contract: this primitive is the canonical entity-merge
 * op for Phase 41 (A), Phase 42 (B), Phase 43 (C). B's `mergeEntityGroup`
 * and C's local merge logic will be deleted in favor of this function
 * during their respective migration phases.
 *
 * WR-02 enforcement: pre-flight check throws BEFORE building the batch if
 * any duplicate already has a SUPERSEDED_BY out-edge. Mirrors
 * GraphKMStore.ts:440-450 verbatim (load-bearing error message text per
 * Phase 39 WR-02 fix).
 *
 * CR-01 widening: every `putEntity` BatchOp carries `skipOntologyCheck: true`
 * — required so the trusted path's pre-stamping is honored (the closed-
 * duplicate write would otherwise re-trigger D-30 provenance auto-assembly
 * via the strict path and overwrite the duplicate's prior provenance).
 *
 * CF-D17 atomicity: a single `store.batch([...])` call covers all merge
 * ops. Phase 37 D-17 guarantees all-or-nothing on Phase 1 validation
 * failure — no torn state possible.
 *
 * Edge-enumeration dedupe: `store.findRelations({ from: dup.id })` AND
 * `store.findRelations({ to: dup.id })` BOTH return self-loop edges (where
 * `from === to === dup.id`). Without identity-key dedupe (`from|to|type|
 * createdAt`), the same self-loop would emit two `removeRelation` BatchOps
 * and be counted twice in `edgesRewired`. The Set<string> of seenEdges
 * collapses this to one BatchOp per unique edge.
 *
 * @throws if `survivorId` is not in the graph.
 * @throws if any `duplicateIds` is not in the graph.
 * @throws if `duplicateIds.includes(survivorId)`.
 * @throws if `duplicateIds.length === 0`.
 * @throws WR-02 if any duplicate already has a SUPERSEDED_BY successor.
 */
export async function mergeEntities(
  store: GraphKMStore,
  survivorId: EntityId,
  duplicateIds: EntityId[],
  opts: MergeOptions,
): Promise<MergeResult> {
  const startTs = Date.now();

  // --- Pre-flight (throw fast, before any mutation) ---

  if (duplicateIds.length === 0) {
    throw new Error('mergeEntities: duplicateIds must be non-empty');
  }
  if (duplicateIds.includes(survivorId)) {
    throw new Error(
      `mergeEntities: survivor ${String(survivorId)} cannot be in duplicateIds`,
    );
  }

  const survivor = await store.getEntity(survivorId);
  if (survivor === undefined) {
    throw new Error(
      `mergeEntities: survivor ${String(survivorId)} not found`,
    );
  }

  const duplicates: Entity[] = [];
  for (const dupId of duplicateIds) {
    const dup = await store.getEntity(dupId);
    if (dup === undefined) {
      throw new Error(
        `mergeEntities: duplicate ${String(dupId)} not found`,
      );
    }
    duplicates.push(dup);
  }

  // WR-02 single-successor invariant (mirrors GraphKMStore.ts:440-450).
  // The error-message text is intentionally identical to the store's
  // write-time check so callers can pattern-match on one string.
  for (const dup of duplicates) {
    const existingSuccessors = await store.findRelations({
      from: dup.id,
      type: 'SUPERSEDED_BY',
    });
    if (existingSuccessors.length > 0) {
      throw new Error(
        `Entity ${String(dup.id)} already has a successor — cannot supersede twice (WR-02 single-successor invariant)`,
      );
    }
  }

  // --- Build the batch (single atomic store.batch call) ---

  const oldValidUntil = new Date().toISOString();
  const ops: BatchOp[] = [];
  let edgesRewired = 0;
  let segmentsMerged = 0;

  // Running survivor state — accumulates segment folds across all
  // duplicate iterations so each fold sees the prior fold's segments.
  let mergedSurvivor: Entity = survivor;

  for (const dup of duplicates) {
    // (a) Close the duplicate (validUntil + updatedAt = oldValidUntil).
    //     skipOntologyCheck:true on this op:
    //       - bypasses re-validation of the duplicate's entityType
    //         (already validated on its own original write).
    //       - critically, on the trusted path the per-op putEntity does
    //         NOT re-assemble EntityProvenance from D-32 (the trusted
    //         path is a no-op for provenance), so the duplicate's
    //         original provenance is preserved verbatim.
    const closedDup: Entity = {
      ...dup,
      validUntil: oldValidUntil,
      updatedAt: oldValidUntil,
    };
    ops.push({ type: 'putEntity', entity: closedDup, skipOntologyCheck: true });

    // (b) SUPERSEDED_BY forward edge (D-33 reverse-walk index).
    ops.push({
      type: 'addRelation',
      relation: {
        type: 'SUPERSEDED_BY',
        from: dup.id,
        to: survivor.id,
        createdAt: oldValidUntil,
        validFrom: oldValidUntil,
      },
    });

    // (c) Edge rewires — enumerate BEFORE the batch (queries are not part
    //     of the batch). Dedupe by identity key (from|to|type|createdAt)
    //     to collapse the from-side+to-side overlap on self-loop edges.
    const outEdges = await store.findRelations({ from: dup.id });
    const inEdges = await store.findRelations({ to: dup.id });
    const seenEdges = new Set<string>();
    const dedupedEdges: Relation[] = [];
    for (const edge of [...outEdges, ...inEdges]) {
      const key = edgeIdentityKey(edge);
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      dedupedEdges.push(edge);
    }

    for (const edge of dedupedEdges) {
      const newFrom: EntityId =
        edge.from === dup.id ? (survivor.id as EntityId) : (edge.from as EntityId);
      const newTo: EntityId =
        edge.to === dup.id ? (survivor.id as EntityId) : (edge.to as EntityId);

      if (newFrom === newTo) {
        // Self-loop after rewire — drop the original without a replacement.
        // No edgesRewired bump (no edge lands on the survivor side).
        ops.push({ type: 'removeRelation', relation: edge });
        continue;
      }

      // Rewire: remove the original, add a replacement with type+metadata
      // preserved verbatim and the endpoint swapped.
      ops.push({ type: 'removeRelation', relation: edge });
      ops.push({
        type: 'addRelation',
        relation: {
          ...edge,
          from: newFrom,
          to: newTo,
        },
      });
      edgesRewired += 1;
    }

    // (d) Segment fold (per-segment via Phase 39 helper).
    if (opts.mergeSegments !== false) {
      const dupSegments = (dup.metadata?.descriptionSegments ?? []) as
        | Array<import('../types/entity.js').DescriptionSegment>
        | undefined;
      if (Array.isArray(dupSegments) && dupSegments.length > 0) {
        for (const segment of dupSegments) {
          mergedSurvivor = mergeDescriptionSegment(mergedSurvivor, segment);
          segmentsMerged += 1;
        }
      }
    }
  }

  // (e) Final survivor write — bumped confirmationCount + lastConfirmedBy
  //     + appended resolutionHistory (one record per merged duplicate).
  //
  //     Provenance handling (trusted-path pre-stamping per CF-D30):
  //       - createdBy preserved from the survivor's original provenance.
  //       - lastConfirmedBy updated to opts.provenance.
  //       - confirmationCount bumped by duplicateIds.length (one
  //         confirmation per merged duplicate).
  //     The trusted path's putEntity does NOT auto-assemble provenance
  //     (Phase 39 D-32 is gated on the strict path), so we stamp here.
  const existingProv = mergedSurvivor.metadata?.provenance as
    | import('../types/entity.js').EntityProvenance
    | undefined;
  const baseConfirmationCount = existingProv?.confirmationCount ?? 1;
  const createdBy = existingProv?.createdBy ?? opts.provenance;
  const newProvenance: import('../types/entity.js').EntityProvenance = {
    createdBy,
    lastConfirmedBy: opts.provenance,
    confirmationCount: baseConfirmationCount + duplicateIds.length,
  };

  const existingResolutionHistory =
    (mergedSurvivor.metadata?.resolutionHistory as
      | Array<Record<string, unknown>>
      | undefined) ?? [];
  // Each duplicate -> one new resolution record. Shape is a SUPERSET of
  // the existing `ResolutionRecord` type (entity.ts:101-111) so legacy
  // consumers reading the 4-field projection still work; we also stamp
  // `mergedAt`, `mergedBy`, and (optionally) `mergedReason` so the plan's
  // richer audit contract is preserved.
  const newRecords = duplicates.map((dup) => {
    const rec: Record<string, unknown> = {
      // Legacy 4-field shape (ResolutionRecord interface)
      mergedEntityId: String(dup.id),
      mergedEntityName: dup.name,
      ontologyClass: dup.ontologyClass ?? dup.entityType,
      timestamp: oldValidUntil,
      // Plan-mandated enrichment (CF-D30 audit trail)
      mergedAt: oldValidUntil,
      mergedBy: opts.provenance,
    };
    if (opts.reason !== undefined) {
      rec.mergedReason = opts.reason;
    }
    return rec;
  });

  const finalSurvivor: Entity = {
    ...mergedSurvivor,
    updatedAt: oldValidUntil,
    metadata: {
      ...(mergedSurvivor.metadata ?? {}),
      provenance: newProvenance,
      resolutionHistory: [...existingResolutionHistory, ...newRecords],
    },
  };

  ops.push({
    type: 'putEntity',
    entity: finalSurvivor,
    skipOntologyCheck: true,
  });

  // --- Execute (single atomic batch — CF-D17) ---
  process.stderr.write(
    `[km-core/maintenance] mergeEntities: survivor=${String(survivor.id)} duplicates=${String(duplicateIds.length)} edgesRewired=${String(edgesRewired)} segmentsMerged=${String(segmentsMerged)}\n`,
  );
  await store.batch(ops);

  return {
    survivorId,
    duplicateIds,
    edgesRewired,
    segmentsMerged,
    oldValidUntil,
    durationMs: Date.now() - startTs,
  };
}

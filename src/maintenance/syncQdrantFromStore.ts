// Phase 42 Plan 04 Task 2 (D-52a): syncQdrantFromStore maintenance op.
//
// Reads all entities with non-empty embedding from the km-core store and
// upserts them into a caller-supplied Qdrant client. Mirrors Phase 40's
// `LLMClient` / Phase 40's `EmbeddingClient` precedent: km-core defines
// a minimal *structural* `QdrantClient` interface and the caller supplies
// the concrete instance — km-core stays Qdrant-agnostic at the type
// level (zero @qdrant/* dependency, single source of truth: caller).
//
// Why a sub-path under @fwornle/km-core/maintenance rather than its own
// /qdrant sub-path:
//   - Phase 41 D-50 already established that post-hoc resolution + atomic
//     primitives live under ./maintenance (alongside resolveEntities and
//     mergeEntities).
//   - This op is *post-hoc index rebuild* — the natural neighbor of
//     resolveEntities. Lifting it into its own sub-path would fragment
//     the maintenance surface.
//
// Composition contract (mirrors mergeEntities.ts):
//   - Iterate via `store.iterate()` (async iterator from Plan 37-04).
//   - Per-entity: skip when `entity.embedding` absent or `length === 0`.
//   - Otherwise build a Qdrant point:
//       { id: entity.legacyId?.id ?? entity.id,
//         vector: entity.embedding,
//         payload: { entityType, ontologyClass, name } }
//     Per D-52a the point id is `legacyId.id` when set (stable across
//     re-syncs even after canonical Entity.id is reminted) and falls
//     back to `entity.id` otherwise.
//   - Buffer points up to `opts.batchSize` (default 100), then
//     `await opts.qdrantClient.upsert(opts.collection, batch)`.
//     On success: `syncedCount += batch.length`.
//     On error: push one entry per failing-batch entity id to errors[]
//     with the caught error message, then continue to the next batch.
//     (Matches Phase 41 resolveEntities resilience — never abort the
//     whole sync on a single batch failure.)
//   - After iteration, flush the final partial batch with the same
//     try/catch semantics.
//   - Optional `opts.log(event)` callback for tracing batch/error
//     events; absence is silent.
//
// no-console-log: all diagnostics via `process.stderr.write` per project
// rule. Prefix: `[km-core/maintenance]`.

import type { Entity } from '../types/entity.js';
import type { GraphKMStore } from '../store/GraphKMStore.js';

/**
 * Minimal structural Qdrant-client interface. km-core stays Qdrant-agnostic
 * — the caller supplies the concrete instance. Matches both
 * `@qdrant/js-client-rest` and `@qdrant/qdrant-js` 1.x at the call shape
 * the caller's wrapper exposes (Plan precedent: Phase 40 LLMClient pattern).
 *
 * Note on real-world shape: vendor SDKs typically expose
 * `client.upsert(collection, { points })` rather than `client.upsert(
 * collection, points)`. Callers wrap their concrete SDK so the wrapper
 * matches THIS interface — that keeps km-core free of vendor-shape
 * dependencies. Example wrapper:
 *
 * ```ts
 * const qdrantClient: QdrantClient = {
 *   upsert: async (collection, points) =>
 *     void (await realClient.upsert(collection, { points })),
 * };
 * ```
 */
export interface QdrantClient {
  upsert(
    collection: string,
    points: Array<{
      id: string | number;
      vector: number[];
      payload?: Record<string, unknown>;
    }>,
  ): Promise<void>;
}

/**
 * Trace event emitted via `opts.log?(event)`. Two discriminators:
 *
 * - `'batch'` — one event per successful `upsert` call. `count` is the
 *   batch size; `cumulative` is the running `syncedCount`.
 * - `'error'` — one event per FAILING batch (every entity in the batch
 *   is recorded in errors[] with the same message); `count` is the
 *   failed batch's size; `message` is the caught error message.
 */
export type SyncQdrantEvent =
  | { phase: 'batch'; count: number; cumulative: number }
  | { phase: 'error'; count: number; message: string };

/** Options bag for `syncQdrantFromStore`. */
export interface SyncQdrantOptions {
  /** Caller-supplied Qdrant client (see `QdrantClient` interface). */
  qdrantClient: QdrantClient;
  /** Qdrant collection name to upsert into. */
  collection: string;
  /** Points per upsert call. Default 100. */
  batchSize?: number;
  /** Optional trace callback (batch/error events). */
  log?: (event: SyncQdrantEvent) => void;
}

/** Result returned by `syncQdrantFromStore` on success. */
export interface SyncQdrantResult {
  /** Total entities upserted across all successful batches. */
  syncedCount: number;
  /** Total entities skipped because embedding was absent or empty. */
  skippedCount: number;
  /** Per-entity error entries from any failing batch (does NOT abort the sync). */
  errors: Array<{ entityId: string; message: string }>;
}

/**
 * Read all entities with non-empty embedding from `store` and upsert them
 * into the caller's Qdrant collection in batches of `opts.batchSize`
 * (default 100).
 *
 * Idempotent: re-running with the same store state produces the same
 * upsert payloads (Qdrant overwrites by id). No "already synced" tracking
 * — Qdrant's overwrite semantics + stable point ids (legacyId.id ?? id)
 * is the contract.
 *
 * Errors per batch are captured in `result.errors[]` and the sync
 * continues — single-batch failure does NOT abort the whole sweep.
 */
export async function syncQdrantFromStore(
  store: GraphKMStore,
  opts: SyncQdrantOptions,
): Promise<SyncQdrantResult> {
  const batchSize = opts.batchSize ?? 100;
  if (batchSize <= 0) {
    throw new Error(
      `syncQdrantFromStore: batchSize must be > 0 (got ${batchSize})`,
    );
  }

  const result: SyncQdrantResult = {
    syncedCount: 0,
    skippedCount: 0,
    errors: [],
  };

  interface PointWithSourceId {
    id: string | number;
    vector: number[];
    payload?: Record<string, unknown>;
    /** Source entity id used ONLY for error-row attribution. */
    _sourceId: string;
  }

  let batch: PointWithSourceId[] = [];

  async function flush(): Promise<void> {
    if (batch.length === 0) return;
    const current = batch;
    batch = [];
    try {
      // Strip the internal `_sourceId` field before calling the client.
      const points = current.map(({ id, vector, payload }) => ({
        id,
        vector,
        payload,
      }));
      await opts.qdrantClient.upsert(opts.collection, points);
      result.syncedCount += current.length;
      opts.log?.({
        phase: 'batch',
        count: current.length,
        cumulative: result.syncedCount,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const p of current) {
        result.errors.push({ entityId: p._sourceId, message });
      }
      opts.log?.({ phase: 'error', count: current.length, message });
      process.stderr.write(
        `[km-core/maintenance] syncQdrantFromStore: batch of ${current.length} failed: ${message}\n`,
      );
    }
  }

  for await (const entity of store.iterate()) {
    if (!entity.embedding || entity.embedding.length === 0) {
      result.skippedCount += 1;
      continue;
    }
    const pointId =
      entity.legacyId?.id !== undefined ? entity.legacyId.id : entity.id;
    batch.push({
      id: pointId,
      vector: entity.embedding,
      payload: buildPayload(entity),
      _sourceId: String(entity.id),
    });
    if (batch.length >= batchSize) {
      await flush();
    }
  }
  await flush();

  process.stderr.write(
    `[km-core/maintenance] syncQdrantFromStore: synced=${result.syncedCount} skipped=${result.skippedCount} errors=${result.errors.length}\n`,
  );

  return result;
}

function buildPayload(entity: Entity): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    entityType: entity.entityType,
    name: entity.name,
  };
  if (entity.ontologyClass !== undefined) {
    payload.ontologyClass = entity.ontologyClass;
  }
  return payload;
}

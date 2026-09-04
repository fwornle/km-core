// Phase 42 Plan 04 Task 3 (D-52c): default FastembedEmbeddingClient.
//
// Thin wrapper around the `fastembed` Node package (Anush008/fastembed-js).
// Implements the Phase 40 `EmbeddingClient` interface
// (src/dedup/CosineEmbeddingMatcher.ts) so the layered deduplicator and
// any future embedding-consumer in km-core can take this as a drop-in
// default — without forcing any direct consumer (LayeredDeduplicator,
// IngestPipeline, future syncQdrantFromStore embedding-aware caller)
// to depend on the fastembed package itself.
//
// SOURCE: model + cacheDir + queryEmbed pattern lifted from B's existing
// embedding pipeline at
//   <coding-repo>/src/embedding/embedding-service.ts
// which is the live, production-validated fastembed integration. Three
// Phase 28 memory notes hold:
//   - "Set absolute cacheDir in FlagEmbedding.init() to prevent
//     CWD-relative model loading" — applied via path.resolve in the ctor
//     when caller does not pass a cacheDir; default points at
//     `<package-root>/.fastembed-cache`. The plan-text suggested
//     "<projectRoot>/local_cache" which is host-specific; we use a
//     package-local cache to keep the default portable. Callers who
//     care override via `opts.cacheDir`.
//   - "queryEmbed returns Float32Array converted via Array.from()" —
//     applied verbatim in `embed()` / `embedBatch()`.
//   - "Reset _initPromise on failure for retry support" — applied in
//     `initialize()`. When the lazy-init throws, _initPromise is cleared
//     so a subsequent call can retry instead of awaiting the rejected
//     promise forever.
//
// DELTA vs the plan's stated interface contract:
//   The plan's <interfaces> block (42-04-PLAN.md lines 110-113) claimed
//   km-core's EmbeddingClient interface had signature
//     `embed(texts: string[]): Promise<number[][]>`.
//   The ACTUAL interface in /src/dedup/CosineEmbeddingMatcher.ts is
//     `embed(text: string): Promise<Float32Array | number[]>`
//   (single-text → single-vector). The single-text shape is what
//   CosineEmbeddingMatcher consumes (see CosineEmbeddingMatcher.ts
//   lines 116-120). Implementing the plan's claimed batch shape would
//   BREAK the existing EmbeddingClient contract and the existing
//   CosineEmbeddingMatcher. Resolution: implement `embed(text: string):
//   Promise<number[]>` per the real interface; expose a separate
//   `embedBatch(texts: string[]): Promise<number[][]>` for batch
//   ergonomics (mirrors B's existing
//   src/embedding/embedding-service.ts split). Documented as
//   deviation Rule 1 in 42-04-SUMMARY.

import { EmbeddingModel, FlagEmbedding } from 'fastembed';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { EmbeddingClient } from '../dedup/CosineEmbeddingMatcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
/** Package-root default cache dir; callers override via opts.cacheDir. */
const DEFAULT_CACHE_DIR = resolve(
  join(__dirname, '..', '..', '.fastembed-cache'),
);

/**
 * Pluggable fastembed initializer — defaults to `FlagEmbedding.init`. Used
 * by tests to inject a stub model without downloading ~80MB of ONNX
 * weights. Production callers should NEVER override this (the default IS
 * the contract per D-52c).
 */
export type FlagEmbeddingInit = (opts: {
  model: Exclude<EmbeddingModel, EmbeddingModel.CUSTOM>;
  cacheDir: string;
}) => Promise<FastembedQueryable>;

/**
 * Minimal structural shape of the FlagEmbedding instance we depend on.
 * Lifted from `fastembed` v2.x — `queryEmbed` (single) + `embed` (async
 * generator of batches). Defining this structurally rather than via the
 * `FlagEmbedding` class type means tests can inject a stub of just these
 * two methods.
 */
export interface FastembedQueryable {
  queryEmbed(text: string): Promise<ArrayLike<number> | Float32Array>;
  embed(
    texts: string[],
    batchSize?: number,
  ): AsyncGenerator<Array<ArrayLike<number> | Float32Array>>;
}

/** Ctor options for FastembedEmbeddingClient (CF-D14 options-object). */
export interface FastembedEmbeddingClientOpts {
  /**
   * EmbeddingModel enum value (excludes `CUSTOM` — caller-supplied custom
   * paths require additional `modelAbsoluteDirPath`/`modelName` plumbing
   * that the default client deliberately does not surface). Default
   * `AllMiniLML6V2` per D-52c (384-dim).
   */
  model?: Exclude<EmbeddingModel, EmbeddingModel.CUSTOM>;
  /** Absolute cache dir for ONNX weights. Default: package-local cache. */
  cacheDir?: string;
  /**
   * Initializer hook — defaults to `FlagEmbedding.init`. Tests inject a
   * stub to avoid downloading weights. Production callers do NOT override.
   */
  initializer?: FlagEmbeddingInit;
}

/**
 * Default `EmbeddingClient` implementation wrapping fastembed
 * `AllMiniLML6V2` (384-dim) per D-52c. Lazy-initializes on first
 * embed call; the loaded model is cached in a private field and
 * reused across all subsequent calls.
 *
 * - `embed(text)` — implements the `EmbeddingClient` interface
 *   (single-text → single-vector). Returns `number[]` (length 384 for
 *   the default model).
 * - `embedBatch(texts, [batchSize])` — convenience helper for callers
 *   that want batched throughput (used by Phase 42 wave-controller +
 *   future syncQdrantFromStore embedding-aware variants). Returns
 *   `number[][]`.
 * - `close()` — optional cleanup hook (no-op in fastembed v2.x — no
 *   resources to release; included for symmetry with future GPU-bound
 *   embedding clients).
 *
 * All diagnostics via `process.stderr.write` per no-console-log rule.
 */
export class FastembedEmbeddingClient implements EmbeddingClient {
  private readonly model: Exclude<EmbeddingModel, EmbeddingModel.CUSTOM>;
  private readonly cacheDir: string;
  private readonly initializer: FlagEmbeddingInit;
  private flag: FastembedQueryable | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(opts: FastembedEmbeddingClientOpts = {}) {
    this.model = opts.model ?? EmbeddingModel.AllMiniLML6V2;
    this.cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
    this.initializer =
      opts.initializer ??
      ((init) =>
        // `init.model` is already constrained to
        // `Exclude<EmbeddingModel, CUSTOM>` by the FlagEmbeddingInit
        // signature — CUSTOM-model paths are out of scope for the
        // default client (D-52c pins AllMiniLML6V2). Cast on the return
        // narrows FlagEmbedding's class type to our structural
        // FastembedQueryable shape (tests inject just the queryEmbed +
        // batch-embed pair; live code gets the same surface from the
        // real FlagEmbedding instance).
        FlagEmbedding.init({
          model: init.model,
          cacheDir: init.cacheDir,
        }) as unknown as Promise<FastembedQueryable>);
  }

  /**
   * Lazy-init the fastembed model. Safe to call multiple times — concurrent
   * callers await the same in-flight promise. On failure, _initPromise is
   * cleared so a retry can start a fresh init (Phase 28 memory note).
   */
  private async initialize(): Promise<void> {
    if (this.flag) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = (async () => {
      try {
        process.stderr.write(
          `[km-core/embeddings] FastembedEmbeddingClient: initializing model=${String(this.model)} cacheDir=${this.cacheDir}\n`,
        );
        this.flag = await this.initializer({
          model: this.model,
          cacheDir: this.cacheDir,
        });
        process.stderr.write(
          `[km-core/embeddings] FastembedEmbeddingClient: model ready\n`,
        );
      } catch (err) {
        // Reset for retry per Phase 28 memory note.
        this.initPromise = null;
        throw err;
      }
    })();
    await this.initPromise;
  }

  /**
   * Embed a single text. Implements the EmbeddingClient interface
   * (single-text → single-vector). Returns `number[]` of length 384 when
   * the default `AllMiniLML6V2` model is used.
   */
  async embed(text: string): Promise<number[]> {
    await this.initialize();
    const vec = await this.flag!.queryEmbed(text);
    return Array.from(vec as ArrayLike<number>);
  }

  /**
   * Embed a batch of texts in one shot. Convenience helper for callers
   * that want batched throughput — Phase 42 wave-controller + future
   * Qdrant-sync embedding-aware variants. Returns `number[][]` whose
   * length matches `texts.length`.
   */
  async embedBatch(texts: string[], batchSize = 64): Promise<number[][]> {
    await this.initialize();
    if (texts.length === 0) return [];
    const out: number[][] = [];
    const generator = this.flag!.embed(texts, batchSize);
    for await (const batch of generator) {
      for (const vec of batch) {
        out.push(Array.from(vec as ArrayLike<number>));
      }
    }
    return out;
  }

  /**
   * Optional cleanup hook. fastembed v2.x exposes no native close path —
   * the ONNX runtime is owned by the module-level FlagEmbedding instance
   * and persists for the lifetime of the process. Provided for symmetry
   * with future GPU-bound clients.
   */
  async close(): Promise<void> {
    this.flag = null;
    this.initPromise = null;
  }
}

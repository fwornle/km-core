// CORE-02 + CORE-03: GraphKMStore — repository class composing
// MultiDirectedGraph (graphology) + PersistenceManager + Exporter +
// UUIDv7 stamping + ontology validation + EventEmitter for hot-write
// notifications.
//
// SOURCES (composite per 37-PATTERNS §"src/store/GraphKMStore.ts"):
//   1. coding/integrations/mcp-server-semantic-analysis/src/storage/
//      graph-database-adapter.ts (B) — repository-class API shape, the
//      mergeAttributes hot path (lines 343-347 of analog).
//   2. _work/.../okm/src/store/graph-store.ts (C) — in-memory Graphology
//      CRUD primitives (addEntity@69, getEntity@80, deleteEntity@135,
//      addEdge@141, filterByLayer@256, export@328, import@332).
//   3. _work/.../okm/src/store/persistence.ts (C) — LevelDB hydrate/
//      fallback wiring; reused via PersistenceManager (Plan 03).
//   4. coding/src/knowledge-management/GraphKnowledgeExporter.js (B) —
//      debounce pattern; reused via Exporter (Plan 03).
//
// DELTAS applied (per 37-PATTERNS §src/store/GraphKMStore.ts DELTAS):
//
//   1. STRIP B's VKB-API fork. No use-api / api-client branches —
//      KM-Core is VKB-unaware. Only the "direct" path is preserved.
//
//   2. EVENT NAMES — emit `entity:put`, `entity:delete`,
//      `relation:added`, `relation:removed` (per D-16). NOT B's
//      legacy "entity-stored" / "relationship-stored" tokens.
//
//   3. PLAIN UUIDv7 nodeIds — NodeId is `entity.id` directly (the
//      UUIDv7 string). NOT C's "layer-colon-uuid" prefix scheme
//      (RESEARCH Open Question #2 — C's Phase 43 migration strips the
//      prefix; KM-Core never introduces it).
//
//   4. EXTEND Node's `EventEmitter` (NOT Redis pub/sub — D-16 explicit
//      in-process emitter; cross-process bridge is a consumer concern).
//
//   5. NO `setEntityProvenance` / `setProvenance` in v0.1 — Phase 39
//      adds those; v0.1 just declares the provenance types.
//
//   6. CONSTRUCTOR takes a `GraphKMStoreOptions` object (D-14) — NOT
//      B's positional `(dbPath, team)` historical accident.
//
//   7. NO `team` concept — KM-Core has no concept of teams. Domain
//      bucketing in the Exporter replaces team-based filing.
//
// Atomicity contract:
//   - `batch(ops)` validates ALL ops FIRST (D-17), then mutates the
//     in-memory graph and fires events. If any op fails validation,
//     the in-memory state is unchanged AND zero events have fired
//     (the round-trip "no event leak on rollback" test exercises this).
//
// Threat-model mitigations:
//   - T-37-04-01 (caller-supplied EntityId injection): putEntity validates
//     caller-supplied `id` via `parseEntityId` BEFORE the entity is stored
//     (skipped when `skipOntologyCheck: true` because that flag implies
//     a trusted bulk-import context — fixture replay, migration backfill).
//   - T-37-04-02 (batch mid-op corruption): validate-all-first design.
//
// Close-time contract (Plan 03 §"Behavior surprises"):
//   - `close()` must `await exporter.flush()` to drain any pending
//     debounced write. The Exporter's `flush` clears the timer and
//     awaits the in-flight `exportJson` if any. The PersistenceManager
//     then persists the final snapshot to LevelDB before closing.

import { MultiDirectedGraph } from 'graphology';
import { EventEmitter } from 'node:events';
import { mintEntityId } from '../ids/mint.js';
import { parseEntityId } from '../ids/parse.js';
import { PersistenceManager } from './persistence.js';
import { Exporter } from './exporter.js';
import {
  noopOntologyValidator,
  registryBackedValidator,
  type OntologyValidator,
} from '../validation/ontology.js';
import { OntologyRegistry } from '../ontology/registry.js';
import type {
  Entity,
  Relation,
  Layer,
  SerializedGraph,
  EntityProvenance,
} from '../types/entity.js';
import type { EntityId } from '../ids/branded.js';
import type { BatchOp, FilterObject, PutEntityOpts } from './types.js';

/**
 * Constructor options for `GraphKMStore`. Object-form per D-14 (NOT
 * positional). All paths are caller-supplied; the library never
 * resolves against process.cwd implicitly.
 */
export interface GraphKMStoreOptions {
  /** LevelDB directory (created if absent). */
  dbPath: string;
  /** Per-domain JSON export directory (created if absent). */
  exportDir: string;
  /** Debounce window for the auto-exporter in ms. Default 5000 (D-22).
   *  Tests typically pass `0` to force synchronous flushes. */
  debounceMs?: number;
  /** Known domain names for per-domain bucketing. Default `['general']`.
   *  Consumers bring their own list (B passes `['coding']`, C passes
   *  `['raas','kpifw','general']`). */
  domains?: readonly string[];
  /** Pluggable ontology validator (D-19). Default is the no-op
   *  validator from `noopOntologyValidator`; Phase 38 wires a strict
   *  registry-backed validator. */
  ontologyValidator?: OntologyValidator;
  /** Directory containing upper.json + lower ontology JSON files
   *  (Phase 38, D-28). When set, GraphKMStore instantiates an
   *  OntologyRegistry internally and auto-wires it as the validator
   *  (unless `ontologyValidator` is ALSO set, which takes precedence —
   *  allows tests to inject stubs).
   *
   *  Default behavior when omitted: no registry; falls back to
   *  `ontologyValidator` or `noopOntologyValidator`. km-core does NOT
   *  default to `<cwd>/ontology/` — D-28 forbids env-var/cwd pickup
   *  buried in helper code. Consumers wire defaults at the call site
   *  (e.g. `ontologyDir: process.env.KM_ONTOLOGY_DIR ?? './ontology'`). */
  ontologyDir?: string;
  /** When true, treats malformed lower-ontology files as fatal
   *  (re-throws) instead of skip+warn. Default false (atomic-build per
   *  D-29). Forwarded to `OntologyRegistry({ strict })`. */
  ontologyStrict?: boolean;
  /** Whether `close()` writes the in-memory snapshot back to LevelDB.
   *  Default `true` — every existing consumer keeps its current
   *  behavior.
   *
   *  Pass `false` when the store is opened purely to READ. `persistGraph`
   *  is a single `db.put('graph:state', JSON.stringify(graph))`, so a
   *  read-only open that closes normally still rewrites the WHOLE graph
   *  as one multi-megabyte value. A request-scoped open/read/close on a
   *  polled HTTP route therefore appends a fresh ~8 MB SST every few
   *  seconds, and LevelDB cannot compact a single hot key fast enough to
   *  keep up: the coding project's experiment store reached 4,821 files /
   *  4.6 GB backing a graph that exports to 8.3 MB, at which point
   *  `open()` alone exceeded the container's 4 GiB cgroup limit and the
   *  kernel OOM-killed the server on every poll (175 kills). Reads must
   *  not write. */
  persistOnClose?: boolean;
}

/**
 * GraphKMStore — composition class wrapping Graphology in-memory graph
 * with LevelDB persistence and per-domain JSON export, exposing the
 * D-14 repository API (`putEntity`, `getEntity`, `deleteEntity`,
 * `findByOntologyClass`, `countByOntologyClass`, `lastModifiedByClass`,
 * `findByLegacyId`, `findByContentHash`, `findRecentByAgent`,
 * `addRelation`, `findRelations`, `batch`, `iterate`, `exportJson`,
 * `mergeAttributes`, `restore`, `open`, `close`).
 *
 * Emits typed events (D-16) on mutation: `entity:put`, `entity:delete`,
 * `relation:added`, `relation:removed`. Consumers can wire these to a
 * cross-process bridge (e.g. coding's Redis pub/sub) as needed.
 */
export class GraphKMStore extends EventEmitter {
  private graph: MultiDirectedGraph<Entity, Relation>;
  private persistence: PersistenceManager;
  private exporter: Exporter;
  private validator: OntologyValidator;
  private readonly registry: OntologyRegistry | undefined;
  private readonly persistOnClose: boolean;
  private initialized = false;

  constructor(opts: GraphKMStoreOptions) {
    super();
    this.persistOnClose = opts.persistOnClose ?? true;
    this.graph = new MultiDirectedGraph<Entity, Relation>();
    this.persistence = new PersistenceManager(opts.dbPath, opts.exportDir, {
      domains: opts.domains,
    });
    this.exporter = new Exporter({
      exportDir: opts.exportDir,
      domains: opts.domains,
      debounceMs: opts.debounceMs,
    });

    // Phase 38: Ontology registry (D-28 — constructor-injected, no env pickup).
    // Build the registry FIRST so the auto-wired validator below can reference it.
    if (opts.ontologyDir !== undefined) {
      this.registry = new OntologyRegistry({
        ontologyDir: opts.ontologyDir,
        strict: opts.ontologyStrict ?? false,
      });
    } else {
      this.registry = undefined;
    }

    // Validator resolution order (most-specific wins):
    //   1. Explicit opts.ontologyValidator (test stubs, custom validators)
    //   2. Auto-wired registry-backed validator (when ontologyDir is set)
    //   3. noopOntologyValidator (legacy / unconfigured default — Phase 37)
    this.validator =
      opts.ontologyValidator
      ?? (this.registry ? registryBackedValidator(this.registry) : noopOntologyValidator);
  }

  /**
   * Read-only access to the OntologyRegistry instance. Returns undefined when
   * `ontologyDir` was not supplied at construction time (legacy / unconfigured
   * stores keep the Phase 37 noop-validator default).
   *
   * Use cases (Phase 39+):
   *   - await store.ontology?.reload() — pick up new ontology files (D-29)
   *   - store.ontology?.getAllClassNames() — enumerate valid classes for UI
   *   - store.ontology?.parentChainOf(class) — extension provenance traversal
   *   - store.ontology?.domains — set of loaded ontology domain names
   *
   * The validator field itself stays private; the registry is the consumer-
   * facing API. The validator is internal plumbing.
   */
  get ontology(): OntologyRegistry | undefined {
    return this.registry;
  }

  /**
   * Hydrate the in-memory graph from durable storage. LevelDB FIRST
   * (cache hot-path), fall back to per-domain JSON exports if LevelDB
   * has nothing (LEVEL_NOT_FOUND). Idempotent — safe to call more than
   * once; only the first call performs the import.
   */
  async open(): Promise<void> {
    if (this.initialized) return;
    const hydrated = await this.persistence.hydrate();
    if (hydrated !== null) {
      // Tolerant import: Graphology's native import() throws on the
      // first bad edge (missing source/target node). We replay nodes
      // then edges with graceful skipping (matches OKM's
      // graph-store.ts:336-365 pattern).
      this.tolerantImport(hydrated);
    }
    this.initialized = true;
  }

  /**
   * Tolerant Graphology import — nodes first, then edges with missing-
   * endpoint skipping. Mirrors OKM's `restore` semantics so a stale
   * .data/exports/*.json that references a since-deleted node does
   * not crash the consumer at open-time.
   */
  private tolerantImport(data: SerializedGraph): void {
    // Phase 1: nodes
    for (const node of data.nodes) {
      try {
        this.graph.addNode(node.key, node.attributes);
      } catch {
        // duplicate — skip
      }
    }
    // Phase 2: edges, skipping those with missing endpoints
    for (const edge of data.edges) {
      if (
        !this.graph.hasNode(edge.source) ||
        !this.graph.hasNode(edge.target)
      ) {
        continue;
      }
      try {
        this.graph.addDirectedEdgeWithKey(
          edge.key,
          edge.source,
          edge.target,
          edge.attributes,
        );
      } catch {
        // duplicate edge — skip
      }
    }
  }

  /**
   * Bulk-import a fully-formed SerializedGraph (e.g. a fixture or a
   * cross-machine migration payload) WITHOUT running per-entity
   * validation or stamping defaults. Preserves all node keys and edge
   * keys verbatim — round-trip parity tests rely on this.
   *
   * No events fire and no debounced export schedules. Caller can
   * follow with `await store.exportJson()` to flush a serialization.
   *
   * Rule 2 (auto-add missing critical functionality): the round-trip
   * parity test imports frozen fixtures whose node/edge keys are NOT
   * v7 UUIDs (C uses the layer-colon-uuid prefix scheme; B uses
   * legacy nanoid-style strings). Per-call `putEntity` strict
   * validation would reject them; per-call mutation would also stamp
   * `createdAt` / `updatedAt` defaults, breaking byte-equal canonical
   * round-trip. `restore` bypasses both — the input IS the
   * authoritative shape.
   */
  async restore(serialized: SerializedGraph): Promise<void> {
    if (!this.initialized) {
      await this.open();
    }
    this.tolerantImport(serialized);
  }

  /**
   * Store an entity. Stamps a fresh UUIDv7 if no `id` is supplied
   * (D-10); validates caller-supplied `id` via `parseEntityId`; runs
   * ontology validation on `entityType` (D-19) unless
   * `skipOntologyCheck: true` is passed.
   *
   * The `skipOntologyCheck: true` flag is also the "bulk-import /
   * trusted-caller" escape hatch — it bypasses BOTH ontology
   * validation AND `parseEntityId`, because trusted callers (fixture
   * replay, Phase 39 backfill of legacy layer-prefixed keys) need
   * to pass non-v7 ids verbatim. The plain (non-bulk) path remains
   * strict per CORE-03.
   *
   * Phase 39 writer-side stamping (D-30/D-31/D-32) lives on the strict
   * (`!trusted`) path:
   *   - D-30: `opts.provenance` is REQUIRED — the store throws if it is
   *     missing. The store never invents a `ProvenanceStamp`.
   *   - D-31: `validFrom` is stamped from `new Date().toISOString()`
   *     when the caller omits it; caller-supplied `validFrom` is kept.
   *   - D-32: create-vs-confirm is decided by `graph.hasNode(id)`. On
   *     first write the store sets `createdBy = lastConfirmedBy =
   *     opts.provenance` and `confirmationCount = 1`. On subsequent
   *     writes for the same id, `createdBy` is preserved,
   *     `lastConfirmedBy` is overwritten with `opts.provenance`, and
   *     `confirmationCount` is incremented.
   *
   * The trusted path (`skipOntologyCheck: true`) bypasses the D-30
   * provenance requirement (BC-2 widening preserved). Backfill callers
   * pre-stamp `entity.metadata.provenance` themselves and pass through
   * verbatim — the strict-path stamping intentionally does NOT run.
   *
   * Emits `entity:put` and schedules a debounced export.
   *
   * WR-01 footgun (Phase 39 REVIEW): the `supersedes` field is the AUTHOR's
   * declaration of intent, NOT a store-maintained invariant. After the D-33
   * supersession closure fires, the new entity is stored with `supersedes`
   * still set on its node attributes — `getEntity()` will return it. This
   * is REQUIRED for `getSupersessionChain` to walk backward from the new
   * entity to its predecessors (D-35 uses `entity.supersedes` as the
   * authoritative backward-traversal pointer; the SUPERSEDED_BY edge is
   * only the forward index).
   *
   * Downstream callers (Phase 40/42/43) that perform read-modify-write
   * patterns on entities MUST be aware: a subsequent strict-path `putEntity`
   * on an existing id with `supersedes` still set is a SILENT NO-OP on the
   * supersession branch (the OQ#4 `!existing` guard saves them — closure +
   * reverse-edge fire ONLY on the create branch; the confirm-write still
   * bumps `lastConfirmedBy` / `confirmationCount`). To explicitly re-attempt
   * supersession on an existing id, delete and recreate the entity.
   * See WR-01 in `.planning/phases/39-entity-data-model/39-REVIEW.md`.
   */
  async putEntity(
    e: Partial<Entity> & { name: string; entityType: string },
    opts?: PutEntityOpts,
  ): Promise<EntityId> {
    const trusted = opts?.skipOntologyCheck === true;

    // D-19 validation — skipped on the trusted path.
    if (!trusted) {
      this.validator.validate(e.entityType);
      // D-30: caller MUST supply provenance on the strict path. The
      // store never invents a ProvenanceStamp; the caller is the source
      // of truth for { provider, model, runId, timestamp }.
      if (!opts?.provenance) {
        throw new Error(
          'putEntity requires opts.provenance (D-30): caller MUST supply ProvenanceStamp source',
        );
      }
    }

    // D-10 stamp-or-keep. On the trusted path we use the caller's id
    // verbatim WITHOUT parseEntityId — round-trip fixtures carry
    // non-v7 ids (C uses layer-prefixed; B uses legacy nanoid keys).
    let id: EntityId;
    if (e.id !== undefined && e.id !== null && e.id !== ('' as EntityId)) {
      if (trusted) {
        id = e.id as EntityId;
      } else {
        id = parseEntityId(e.id as unknown as string);
      }
    } else {
      id = mintEntityId();
    }

    // Build the stored entity. On the trusted path, preserve all input
    // fields verbatim (no default-stamping) — fixture round-trip needs
    // byte-equal canonical output. On the strict path, fill defaults
    // AND apply Phase 39 writer-side stamping (D-31 + D-32).
    let entity: Entity;
    if (trusted) {
      entity = { ...e, id } as Entity;
    } else {
      const now = new Date().toISOString();
      entity = {
        ...e,
        id,
        createdAt: e.createdAt ?? now,
        updatedAt: now,
        layer: (e.layer as Layer) ?? 'evidence',
        description: e.description ?? '',
        metadata: e.metadata ?? {},
      } as Entity;

      // D-31: writer stamps validFrom when caller omits it. Caller-supplied
      // validFrom (e.g. test fixtures, replay) is preserved verbatim.
      entity.validFrom = entity.validFrom ?? now;

      // D-32: create-vs-confirm by graph.hasNode(id).
      //   - First write (id absent from graph): createdBy = lastConfirmedBy
      //     = opts.provenance; confirmationCount = 1.
      //   - Subsequent write (id present): createdBy preserved from prior
      //     EntityProvenance (falls back to opts.provenance if prior write
      //     had no structured provenance — e.g. Phase 37 entities loaded
      //     from a pre-Phase-39 snapshot); lastConfirmedBy = opts.provenance;
      //     confirmationCount incremented from prior (or 0 if absent).
      const existing = this.graph.hasNode(id)
        ? (this.graph.getNodeAttributes(id) as Entity)
        : undefined;
      const existingProv = existing?.metadata?.provenance as
        | EntityProvenance
        | undefined;
      // opts.provenance is non-null on the strict path (D-30 throw above).
      const stamp = opts!.provenance!;
      const newProv: EntityProvenance = existing
        ? {
            createdBy: existingProv?.createdBy ?? stamp,
            lastConfirmedBy: stamp,
            confirmationCount: (existingProv?.confirmationCount ?? 0) + 1,
          }
        : {
            createdBy: stamp,
            lastConfirmedBy: stamp,
            confirmationCount: 1,
          };
      entity.metadata = {
        ...(entity.metadata ?? {}),
        provenance: newProv,
      };

      // D-33 supersession closure: if a NEW entity supersedes an old one,
      // atomically (a) close the old entity's validUntil, (b) write the new
      // entity, (c) materialize a SUPERSEDED_BY edge for D-35 reverse walk.
      //
      // Guarded by `!existing` per OQ#4 resolution (39-RESEARCH.md): a
      // confirm-write that re-asserts `supersedes` against an EXISTING id is
      // a silent no-op on this branch — predecessor closure + SUPERSEDED_BY
      // edge fire ONLY on the create branch. The confirm-write itself
      // (lastConfirmedBy / confirmationCount update above) still happens.
      if (entity.supersedes !== undefined && !existing) {
        const oldId = entity.supersedes as EntityId;
        const oldEntity = this.graph.hasNode(oldId)
          ? (this.graph.getNodeAttributes(oldId) as Entity)
          : undefined;
        if (!oldEntity) {
          throw new Error(
            `Supersession target ${String(oldId)} not in graph`,
          );
        }
        // WR-02 write-time enforcement: a single predecessor entity may
        // have AT MOST ONE successor. Two rapid concurrent (or buggy)
        // putEntity calls with `supersedes: sameOldId` could otherwise
        // each write a SUPERSEDED_BY edge from `oldId`, violating the
        // single-successor contract and making `getSupersessionChain`
        // forward walk non-deterministic. Surface the violation here
        // before it becomes a silent data-integrity issue. See WR-02 in
        // `.planning/phases/39-entity-data-model/39-REVIEW.md`.
        let existingSuccessors = 0;
        this.graph.forEachOutEdge(oldId, (_key, attrs) => {
          if ((attrs as Relation).type === 'SUPERSEDED_BY') {
            existingSuccessors += 1;
          }
        });
        if (existingSuccessors > 0) {
          throw new Error(
            `Entity ${String(oldId)} already has a successor — cannot supersede twice (WR-02 single-successor invariant)`,
          );
        }
        if (oldEntity.validUntil !== undefined) {
          process.stderr.write(
            `[km-core/store] overwriting validUntil for ${String(oldId)} (was ${oldEntity.validUntil})\n`,
          );
        }
        const closedOld: Entity = {
          ...oldEntity,
          validUntil: entity.validFrom!,
          updatedAt: entity.validFrom!,
        };
        // Atomic two-write — batch() guarantees all-or-nothing (D-17). batch's
        // internal putEntity call passes { skipOntologyCheck: true } per Plan
        // 01, so neither write re-enters this branch (trusted path skips the
        // entire `!trusted` block including this supersession-closure).
        //
        // Phase 39 CR-01 fix: both ops carry per-op `skipOntologyCheck: true`
        // so batch() Phase 1 bypasses `parseEntityId` for both `closedOld`
        // (which may have a non-v7 legacy id — nanoid, layer-prefixed, or any
        // id stored via the trusted path) AND `entity` (whose id is v7, but
        // setting the flag uniformly keeps the supersession-closure write
        // self-consistent). Without this, cross-epoch supersession (v7
        // successor → legacy-id predecessor) silently throws in Phase 1
        // and D-33 atomicity breaks. See REVIEW.md CR-01.
        await this.batch([
          { type: 'putEntity', entity: closedOld, skipOntologyCheck: true },
          { type: 'putEntity', entity, skipOntologyCheck: true },
        ]);
        // Materialize SUPERSEDED_BY edge for D-35 reverse-walk index
        // (Pattern 2A.1 — single source of truth in Graphology, no
        // separate Map). batch() already fired emit + scheduleExport
        // for both writes; addRelation fires its own relation:added.
        await this.addRelation({ type: 'SUPERSEDED_BY', from: oldId, to: id });
        return id;
      }
    }

    // Graphology merge (C analog graph-store.ts:71 — but plain UUID
    // nodeId per Delta 3, NOT layer-prefixed).
    this.graph.mergeNode(id, entity);

    // emit + schedule export (D-16 + D-22).
    this.emit('entity:put', { entity });
    this.exporter.scheduleExport(this.graph.export() as SerializedGraph);

    return id;
  }

  /**
   * Retrieve an entity by id. Returns `undefined` if the node is
   * absent — matches the test contract
   * (`expect(await ctx.store.getEntity(id)).toBeUndefined()`).
   *
   * WR-01 footgun reminder (Phase 39 REVIEW): the returned entity may
   * carry `supersedes` as a stored attribute when it superseded a
   * predecessor at create time. This field is the AUTHOR's declaration
   * (the authoritative backward-traversal pointer for
   * `getSupersessionChain`), NOT a store-maintained invariant. Callers
   * doing read-modify-write should NOT pass the field back through
   * `putEntity` unless they explicitly want to re-attempt supersession —
   * and even then the OQ#4 `!existing` guard makes it a no-op on the
   * supersession branch (closure fires only on the create branch). See
   * `putEntity` JSDoc for the full footgun discussion.
   */
  async getEntity(id: EntityId): Promise<Entity | undefined> {
    if (!this.graph.hasNode(id)) return undefined;
    return this.graph.getNodeAttributes(id) as Entity;
  }

  /**
   * Delete an entity. Returns `true` if a node was removed, `false`
   * if no such node existed. Emits `entity:delete` with `{ id }`.
   */
  async deleteEntity(id: EntityId): Promise<boolean> {
    if (!this.graph.hasNode(id)) return false;
    this.graph.dropNode(id);
    this.emit('entity:delete', { id });
    this.exporter.scheduleExport(this.graph.export() as SerializedGraph);
    return true;
  }

  /**
   * D-34: active-only filter helper. Entities without `validUntil` are
   * ALWAYS treated as active — this short-circuit (`validUntil ===
   * undefined || validUntil === null`) is what preserves Phase 37/38
   * backward compatibility: none of the existing 33 tests set
   * `validUntil`, so the new active-only default does not regress them.
   *
   * The `null` branch is the JSON-roundtrip BC fix (Phase 44 debug):
   * Phase 42/44 migrations (`migrate-sqlite-to-kmcore.mjs`,
   * `augment-team-field-42.2.mjs`) emit `validUntil: null` for every
   * entity. Without this branch, every node in the persisted
   * `general.json` is filtered out by default (`new Date(null)
   * .getTime() === 0`, which is `<= nowMs`). Treating `null` and
   * `undefined` identically is the "no expiry" semantic that matches
   * caller intent AND OKM legacy behavior. See
   * `.planning/phases/44-rest-api-git-snapshots/44-DEBUG-SUMMARY-typed-views.md`.
   *
   * Entities WITH a real `validUntil` string are active iff
   * `new Date(validUntil).getTime() > nowMs`.
   */
  private isActive(entity: Entity, nowMs: number): boolean {
    if (entity.validUntil === undefined || entity.validUntil === null) return true;
    return new Date(entity.validUntil).getTime() > nowMs;
  }

  /**
   * Find every entity whose `entityType` OR `ontologyClass` matches.
   * Both fields are checked because 37-PATTERNS notes OKM keeps both
   * in transit (entityType is authoritative; ontologyClass is the
   * legacy alias retained for BC during Phase 38).
   *
   * Phase 39 D-34: filters out superseded entities (`validUntil` set
   * AND `<= now`) by default. Pass `{ includeSuperseded: true }` to
   * receive the full history including superseded entries. Entities
   * with `validUntil === undefined` ALWAYS pass the filter (BC short-
   * circuit — preserves Phase 37/38 behavior).
   */
  async findByOntologyClass(
    cls: string,
    opts?: { includeSuperseded?: boolean },
  ): Promise<Entity[]> {
    const includeSuperseded = opts?.includeSuperseded === true;
    const nowMs = Date.now();
    const matches: Entity[] = [];
    for (const nodeId of this.graph.nodes()) {
      const entity = this.graph.getNodeAttributes(nodeId) as Entity;
      if (entity.entityType !== cls && entity.ontologyClass !== cls) continue;
      if (!includeSuperseded && !this.isActive(entity, nowMs)) continue;
      matches.push(entity);
    }
    return matches;
  }

  /**
   * Phase 44 Plan 14 (T-44-14-01) — efficient COUNT helper for dashboard
   * top-line counters at :3032. Iterates the ontology-class filter (same
   * OR-gate as `findByOntologyClass`: entityType === cls || ontologyClass
   * === cls) and counts matches WITHOUT materialising the entity array.
   *
   * Cost model:
   *   - Without `opts.predicate`: O(N) over all nodes, no array allocation.
   *     (Note: a true O(1) is not achievable without an index over the
   *     ontology-class attribute; graphology v0.26 has no attribute index.
   *     N is bounded by total node count which is currently ~4k on this
   *     machine — the O(N) scan completes in <5ms.)
   *   - With `opts.predicate`: O(N_class) — predicate runs on each match.
   *
   * Applies D-34 active-only filtering by default (matching
   * `findByOntologyClass`). Empty-class case returns 0 (does NOT throw).
   *
   * Used by `GET /api/consolidation/status` (Plan 44-14 Task 2(g)) to
   * compute `totalObs` / `totalDigests` / `totalInsights` without
   * dragging the entity array into the response handler's hot path.
   */
  async countByOntologyClass(
    cls: string,
    opts?: {
      includeSuperseded?: boolean;
      predicate?: (entity: Entity) => boolean;
    },
  ): Promise<number> {
    const includeSuperseded = opts?.includeSuperseded === true;
    const predicate = opts?.predicate;
    const nowMs = Date.now();
    let count = 0;
    for (const nodeId of this.graph.nodes()) {
      const entity = this.graph.getNodeAttributes(nodeId) as Entity;
      if (entity.entityType !== cls && entity.ontologyClass !== cls) continue;
      if (!includeSuperseded && !this.isActive(entity, nowMs)) continue;
      if (predicate !== undefined && !predicate(entity)) continue;
      count += 1;
    }
    return count;
  }

  /**
   * Phase 44 Plan 14 (T-44-14-06) — staleness clock helper for the
   * dashboard real-time-staleness badge ([📚] in the health-coordinator
   * statusline). Returns the ISO-8601 string of the maximum `createdAt`
   * across all entities matching `cls`, or `null` when the class is
   * empty.
   *
   * ISO-8601 strings compare lexicographically (sort identical to date
   * order), so the implementation is a simple max-scan without Date
   * construction. D-34 active-only filtering applies by default.
   *
   * Cost: O(N) over all nodes (no attribute index — see
   * `countByOntologyClass` cost-model note). Caller (obs-api) wraps this
   * with a 5s TTL cache (T-44-14-06 mitigation) and invalidates on
   * writer publish so a fresh ETM observation flows through within ~5s.
   */
  async lastModifiedByClass(
    cls: string,
    opts?: { includeSuperseded?: boolean },
  ): Promise<string | null> {
    const includeSuperseded = opts?.includeSuperseded === true;
    const nowMs = Date.now();
    let max: string | null = null;
    for (const nodeId of this.graph.nodes()) {
      const entity = this.graph.getNodeAttributes(nodeId) as Entity;
      if (entity.entityType !== cls && entity.ontologyClass !== cls) continue;
      if (!includeSuperseded && !this.isActive(entity, nowMs)) continue;
      const ts = entity.createdAt;
      if (typeof ts !== 'string' || ts.length === 0) continue;
      if (max === null || ts > max) {
        max = ts;
      }
    }
    return max;
  }

  /**
   * Phase 44 Plan 14 — resolve an entity by its legacy-system row id.
   * Required by `POST /api/insights/:id/resynthesize` (Task 2(g)) and any
   * other obs-api endpoint that needs to reach the km-core entity whose
   * `legacyId.system === system` AND `legacyId.id === id` (the SQLite
   * primary key encoded by `legacy-ingest.ts`).
   *
   * O(N) scan over all nodes — there is no index over `legacyId`.
   * Returns the first match (legacyId is expected to be unique per
   * (system, id) pair; if duplicates exist that is a data-integrity bug
   * not handled here). Returns `undefined` when no match exists.
   *
   * D-34 active-only filter applies by default. Pass `includeSuperseded:
   * true` to also consider entities whose `validUntil` has elapsed
   * (useful for post-hoc resolution / history walks).
   */
  async findByLegacyId(
    selector: { system: string; id: string },
    opts?: { includeSuperseded?: boolean },
  ): Promise<Entity | undefined> {
    const includeSuperseded = opts?.includeSuperseded === true;
    const nowMs = Date.now();
    for (const nodeId of this.graph.nodes()) {
      const entity = this.graph.getNodeAttributes(nodeId) as Entity;
      const lid = entity.legacyId;
      if (!lid || lid.system !== selector.system || lid.id !== selector.id) continue;
      if (!includeSuperseded && !this.isActive(entity, nowMs)) continue;
      return entity;
    }
    return undefined;
  }

  /**
   * Phase 44 Plan 13 — content-hash dedup lookup for ObservationWriter and
   * future km-core consumers that need the (agent, content_hash) → Entity
   * resolution path.
   *
   * Surfaces the inverse of legacy-ingest.ts:262-274, which stores
   * `metadata.agent = row.agent` and `metadata.content_hash = row.content_hash`
   * (snake_case — the SQLite column names are preserved verbatim under
   * metadata so the writer + migration script + obs-api typed views share
   * one field map). Both fields are checked for equality with the caller-
   * supplied (agent, contentHash) pair; the per-class scan is bounded by
   * `opts.ontologyClass` (default `'Observation'`) so the candidate pool
   * stays at ~3.9k entries in current production (sub-millisecond at this
   * scale).
   *
   * Cost model:
   *   - O(N_class) — scans every entity whose `entityType === cls ||
   *     ontologyClass === cls` and predicates on `metadata.agent` +
   *     `metadata.content_hash`. No secondary index over (agent,
   *     contentHash) exists; threat T-44-13-01 mitigation is the
   *     per-class bound plus a perf assertion in Plan 44-13's integration
   *     test (avg <2ms over 100 calls at 1k pre-seeded observations).
   *
   * Returns the matched entities array (caller picks `[0]` or null). D-34
   * active-only filter applies by default. Empty match returns `[]`, NOT
   * undefined — caller can `.length === 0` check without truthiness traps.
   *
   * Used by:
   *   - `src/live-logging/ObservationWriter.js::_findExistingByContentHash`
   *     (Plan 44-13 Task 2) — replaces the previous SQLite
   *     `SELECT id, summary, metadata FROM observations WHERE agent=? AND
   *     content_hash=? LIMIT 1` lookup.
   */
  async findByContentHash(
    agent: string,
    contentHash: string,
    opts?: { ontologyClass?: string; includeSuperseded?: boolean },
  ): Promise<Entity[]> {
    const cls = opts?.ontologyClass ?? 'Observation';
    const includeSuperseded = opts?.includeSuperseded === true;
    const nowMs = Date.now();
    const matches: Entity[] = [];
    for (const nodeId of this.graph.nodes()) {
      const entity = this.graph.getNodeAttributes(nodeId) as Entity;
      if (entity.entityType !== cls && entity.ontologyClass !== cls) continue;
      const meta = entity.metadata as
        | { agent?: string | null; content_hash?: string | null }
        | undefined;
      if (!meta) continue;
      if (meta.agent !== agent) continue;
      if (meta.content_hash !== contentHash) continue;
      if (!includeSuperseded && !this.isActive(entity, nowMs)) continue;
      matches.push(entity);
    }
    return matches;
  }

  /**
   * Phase 44 Plan 13 — recent-by-agent time-windowed lookup for
   * ObservationWriter semantic dedup and future km-core consumers that
   * need the (agent, sinceISO, limit) → Entity[] resolution path.
   *
   * Returns up to `limit` entities of class `opts.ontologyClass` (default
   * `'Observation'`) whose `metadata.agent === agent` AND
   * `metadata.createdAt > sinceISO`, sorted by `metadata.createdAt` DESC.
   *
   * The timestamp source is `metadata.createdAt` (stamped by
   * legacy-ingest.ts:273 from `row.created_at`) rather than top-level
   * `entity.createdAt` because the legacy-ingest adapter promotes both
   * fields to the same value — keeping the comparison on the metadata
   * path avoids ambiguity when callers replay via `putEntity` and the
   * top-level `entity.createdAt` gets overwritten by Phase 39 D-31
   * stamping (validFrom default).
   *
   * ISO-8601 strings compare lexicographically (sort identical to date
   * order), so the implementation is a string-comparison scan + array
   * sort without Date construction.
   *
   * Cost model:
   *   - O(N_class) iteration + O(K log K) sort where K is the unbounded
   *     count of matches before truncation. In production at ~3.9k
   *     observations with the default 4-hour window, K << N_class and
   *     the overall cost stays sub-millisecond.
   *
   * D-34 active-only filter applies by default. Empty match returns `[]`.
   *
   * Used by:
   *   - `src/live-logging/ObservationWriter.js::_isSemanticallyDuplicate`
   *     (Plan 44-13 Task 2) — replaces the previous SQLite
   *     `SELECT summary FROM observations WHERE agent=? AND
   *     created_at>datetime('now','-4 hours') ORDER BY created_at DESC
   *     LIMIT 50` lookup.
   */
  async findRecentByAgent(
    agent: string,
    sinceISO: string,
    limit: number,
    opts?: { ontologyClass?: string; includeSuperseded?: boolean },
  ): Promise<Entity[]> {
    const cls = opts?.ontologyClass ?? 'Observation';
    const includeSuperseded = opts?.includeSuperseded === true;
    const nowMs = Date.now();
    const matches: Entity[] = [];
    for (const nodeId of this.graph.nodes()) {
      const entity = this.graph.getNodeAttributes(nodeId) as Entity;
      if (entity.entityType !== cls && entity.ontologyClass !== cls) continue;
      const meta = entity.metadata as
        | { agent?: string | null; createdAt?: string | null }
        | undefined;
      if (!meta) continue;
      if (meta.agent !== agent) continue;
      const ts = meta.createdAt;
      if (typeof ts !== 'string' || ts.length === 0) continue;
      if (ts <= sinceISO) continue;
      if (!includeSuperseded && !this.isActive(entity, nowMs)) continue;
      matches.push(entity);
    }
    // Sort by metadata.createdAt DESC (ISO-8601 lexicographic compare).
    matches.sort((a, b) => {
      const ta = (a.metadata as { createdAt?: string }).createdAt ?? '';
      const tb = (b.metadata as { createdAt?: string }).createdAt ?? '';
      if (ta < tb) return 1;
      if (ta > tb) return -1;
      return 0;
    });
    if (limit > 0 && matches.length > limit) {
      matches.length = limit;
    }
    return matches;
  }

  /**
   * Add a relation between two entities. Both endpoints must already
   * exist in the graph (caller is responsible for the put-before-add
   * ordering — Phase 38's bulk loader will refine this).
   *
   * If `r.key` (extended Relation field) is supplied, it is used as
   * the edge key verbatim — round-trip parity from fixture imports
   * relies on this. Otherwise Graphology generates a key.
   *
   * Emits `relation:added` with `{ relation }`.
   */
  async addRelation(
    r: Relation & { key?: string },
  ): Promise<void> {
    if (!this.graph.hasNode(r.from)) {
      throw new Error(`Source node not found: ${String(r.from)}`);
    }
    if (!this.graph.hasNode(r.to)) {
      throw new Error(`Target node not found: ${String(r.to)}`);
    }
    if (r.key !== undefined && r.key !== null) {
      try {
        this.graph.addDirectedEdgeWithKey(r.key, r.from, r.to, r);
      } catch {
        // duplicate key — skip silently (matches OKM tolerant import)
      }
    } else {
      this.graph.addEdge(r.from, r.to, r);
    }
    this.emit('relation:added', { relation: r });
    this.exporter.scheduleExport(this.graph.export() as SerializedGraph);
  }

  /**
   * Find relations matching a partial filter. Linear scan over edges
   * (Graphology has no edge index in v0.26); CORE-02 v0.1 acceptable.
   */
  async findRelations(filter: Partial<Relation>): Promise<Relation[]> {
    const matches: Relation[] = [];
    for (const edgeId of this.graph.edges()) {
      const r = this.graph.getEdgeAttributes(edgeId) as Relation;
      if (filter.type !== undefined && r.type !== filter.type) continue;
      if (filter.from !== undefined && r.from !== filter.from) continue;
      if (filter.to !== undefined && r.to !== filter.to) continue;
      matches.push(r);
    }
    return matches;
  }

  /**
   * Phase 41 Plan 03 — total degree (in + out) for `id`.
   *
   * Thin wrapper around graphology@^0.26's `MultiDirectedGraph.degree(node)`,
   * which returns the SUM of inDegree + outDegree. Distinct from the
   * separate `inDegree` / `outDegree` accessors graphology also exposes —
   * we intentionally surface only the total because the sole Phase 41
   * caller (`resolveEntities`, Plan 06) compares totals to break ties
   * between merge-candidate pairs (OKM survivor-selection heuristic ported
   * from `_work/.../okm/src/ingestion/deduplicator.ts:711-719` — "prefer the
   * higher-degree node when merging duplicates"). YAGNI applies to
   * `inDegree`/`outDegree` separately; they can be added later if needed.
   *
   * Pinned semantics (asserted by tests A and B in
   * `tests/unit/graph-store.test.ts`):
   *   - SINGLE directed edge A→B: degree(A) === 1 (one outgoing counted
   *     once for A) AND degree(B) === 1 (one incoming counted once for B).
   *   - 3 outgoing edges from A (A→B, A→C, A→D): degree(A) === 3
   *     (inDegree=0, outDegree=3, total=3). These literal values are the
   *     contract Plan 06 Test I (degree-based survivor selection) relies on.
   *
   * Missing-node contract (test C): returns `0` and does NOT throw. This
   * is the caller-friendly shape Plan 06's `resolveEntities` expects when
   * one or both of a pair has been concurrently deleted by an earlier
   * merge in the same wave — `0` makes the comparison fall through to
   * the other candidate without special-casing.
   *
   * Async signature (`Promise<number>`) matches the rest of the public
   * surface (Phase 38 `registry.ts` Pattern S4 — async return on sync
   * underlying op for API consistency).
   */
  async getDegree(id: EntityId): Promise<number> {
    if (!this.graph.hasNode(id)) return 0;
    return this.graph.degree(id);
  }

  /**
   * D-35: returns the supersession chain through `id`, ordered by
   * `validFrom` ascending. Walks BACKWARD via `entity.supersedes`
   * (collects predecessors) and FORWARD via `SUPERSEDED_BY` out-edges
   * (collects successors). The input `id` is included in the result.
   *
   * Cycle-guarded via a visited Set (Pitfall 6 mitigation): on revisit
   * the chain is truncated and a stderr-warn fires. If `id` is not in
   * the graph, returns an empty array.
   */
  async getSupersessionChain(id: EntityId): Promise<Entity[]> {
    if (!this.graph.hasNode(id)) return [];
    const visited = new Set<EntityId>();
    // Phase 1: walk backward via the `supersedes` attribute, building
    // `before` in chronological order (prepend each predecessor).
    const before: Entity[] = [];
    let cursor: EntityId | undefined = id;
    while (cursor !== undefined && !visited.has(cursor)) {
      visited.add(cursor);
      if (!this.graph.hasNode(cursor)) break;
      const e = this.graph.getNodeAttributes(cursor) as Entity;
      before.unshift(e);
      cursor = e.supersedes;
    }
    if (cursor !== undefined && visited.has(cursor)) {
      process.stderr.write(
        `[km-core/store] supersession cycle detected at ${String(cursor)}; truncating chain\n`,
      );
    }
    // Phase 2: walk forward via SUPERSEDED_BY out-edges from the input
    // id. `before[]` already includes the input id; `after[]` collects
    // its successors only.
    //
    // WR-02 fix: pick the FIRST unvisited SUPERSEDED_BY successor and
    // warn on any additional matches. Previously the walk used the LAST
    // match (later assignments overwrote earlier candidates), making the
    // traversal non-deterministic when a node had multiple successor
    // edges (a data-integrity violation that the new write-time check
    // above now prevents for fresh writes, but pre-existing forked data
    // could still reach this code path). Defense-in-depth: surface the
    // anomaly via stderr-warn rather than silently picking inconsistent
    // edges. See WR-02 in `.planning/phases/39-entity-data-model/39-REVIEW.md`.
    const after: Entity[] = [];
    cursor = id;
    while (cursor !== undefined) {
      let next: EntityId | undefined;
      const cursorForWarn: EntityId = cursor;
      this.graph.forEachOutEdge(cursor, (_key, attrs, _src, tgt) => {
        const r = attrs as Relation;
        if (r.type === 'SUPERSEDED_BY' && !visited.has(tgt as EntityId)) {
          if (next === undefined) {
            next = tgt as EntityId;
          } else {
            process.stderr.write(
              `[km-core/store] multiple SUPERSEDED_BY successors at ${String(cursorForWarn)}; picking first (${String(next)}), ignoring ${String(tgt)}\n`,
            );
          }
        }
      });
      if (next === undefined) break;
      visited.add(next);
      const e = this.graph.getNodeAttributes(next) as Entity;
      after.push(e);
      cursor = next;
    }
    return [...before, ...after];
  }

  /**
   * Atomic, all-or-nothing batch (D-17). Validates EVERY op first;
   * only then mutates the graph and emits events. If any op fails
   * validation, the in-memory state is unchanged AND zero events
   * have fired (the `batch is all-or-nothing on validation failure`
   * test asserts this exact contract).
   */
  async batch(ops: BatchOp[]): Promise<void> {
    // Phase 1: validate ALL ops. Any throw bubbles BEFORE any mutation.
    for (const op of ops) {
      if (op.type === 'putEntity') {
        // Per-op `skipOntologyCheck` (Phase 39 CR-01 fix): mirrors the BC-2
        // widening that `PutEntityOpts.skipOntologyCheck` provides for the
        // single-call `putEntity`. When `true`, bypasses BOTH ontology
        // validation AND `parseEntityId` for this op. Required by the D-33
        // supersession closure when the predecessor was stored on the
        // trusted path with a non-v7 id (legacy nanoid, layer-prefixed,
        // backfilled). Strict-by-default is preserved — callers MUST opt in.
        const opTrusted = op.skipOntologyCheck === true;
        if (!opTrusted) {
          this.validator.validate(op.entity.entityType);
          if (op.entity.id !== undefined && op.entity.id !== null) {
            parseEntityId(op.entity.id as unknown as string);
          }
        }
      } else if (op.type === 'deleteEntity') {
        parseEntityId(op.id as unknown as string);
      } else if (op.type === 'addRelation' || op.type === 'removeRelation') {
        parseEntityId(op.relation.from as unknown as string);
        parseEntityId(op.relation.to as unknown as string);
      }
    }

    // Phase 2: apply in-memory + emit events. Validation passed — no
    // throws beyond unforeseen Graphology errors (e.g. duplicate keys).
    for (const op of ops) {
      if (op.type === 'putEntity') {
        // Phase 39: batch is a trusted sub-path — strict validation runs
        // in Phase 1 above (validator.validate + parseEntityId), so the
        // individual putEntity bypasses re-validation AND the D-30
        // provenance requirement. Phase 42 may widen BatchOp to carry
        // { provenance } when callers need per-op stamping.
        await this.putEntity(op.entity, { skipOntologyCheck: true });
      } else if (op.type === 'deleteEntity') {
        await this.deleteEntity(op.id);
      } else if (op.type === 'addRelation') {
        await this.addRelation(op.relation);
      } else if (op.type === 'removeRelation') {
        // remove by (from, to, type) match
        for (const edgeId of this.graph.edges()) {
          const r = this.graph.getEdgeAttributes(edgeId) as Relation;
          if (
            r.from === op.relation.from &&
            r.to === op.relation.to &&
            r.type === op.relation.type
          ) {
            this.graph.dropEdge(edgeId);
            this.emit('relation:removed', { relation: r });
            break;
          }
        }
      }
    }
    this.exporter.scheduleExport(this.graph.export() as SerializedGraph);
  }

  /**
   * Lazy async iterator (D-18) over entities matching the filter
   * object. Yields one entity at a time — consumer controls pull.
   * No filter ⇒ yields every entity.
   *
   * Phase 39 D-34: filters out superseded entities (`validUntil` set
   * AND `<= now`) by default. Pass `{ includeSuperseded: true }` to
   * receive the full history. Entities with `validUntil === undefined`
   * ALWAYS pass the filter (BC short-circuit — preserves Phase 37/38
   * behavior; the existing `iterate yields entities lazily and respects
   * filter` test stays green because none of its fixtures set
   * `validUntil`).
   */
  async *iterate(
    filter?: FilterObject,
    opts?: { includeSuperseded?: boolean },
  ): AsyncIterable<Entity> {
    const includeSuperseded = opts?.includeSuperseded === true;
    const nowMs = Date.now();
    for (const nodeId of this.graph.nodes()) {
      const entity = this.graph.getNodeAttributes(nodeId) as Entity;
      if (!this.matches(entity, filter)) continue;
      if (!includeSuperseded && !this.isActive(entity, nowMs)) continue;
      yield entity;
    }
  }

  private matches(entity: Entity, filter?: FilterObject): boolean {
    if (!filter) return true;
    if (
      filter.entityType !== undefined &&
      entity.entityType !== filter.entityType
    ) {
      return false;
    }
    if (
      filter.ontologyClass !== undefined &&
      entity.ontologyClass !== filter.ontologyClass
    ) {
      return false;
    }
    if (filter.layer !== undefined && entity.layer !== filter.layer) {
      return false;
    }
    return true;
  }

  /**
   * Force a synchronous flush of the per-domain JSON export. Used by
   * the round-trip parity test (with `debounceMs: 0`) to bypass the
   * debounce window and assert byte-equal output immediately.
   */
  async exportJson(): Promise<void> {
    await this.exporter.exportJson(this.graph.export() as SerializedGraph);
  }

  /**
   * B's `mergeAttributes` hot path (37-PATTERNS preserves this
   * verbatim from graph-database-adapter.ts:343-347). Used by
   * operator-enriched updates where ontology classification doesn't
   * change but other fields do. Does NOT re-run ontology validation
   * (T-37-04-06 — accepted disposition).
   */
  async mergeAttributes(
    nodeId: EntityId,
    attributes: Partial<Entity>,
  ): Promise<void> {
    if (!this.graph.hasNode(nodeId)) {
      throw new Error(`Node ${String(nodeId)} not found in graph`);
    }
    this.graph.mergeNodeAttributes(nodeId, attributes);
    this.emit('entity:put', {
      entity: this.graph.getNodeAttributes(nodeId) as Entity,
    });
    this.exporter.scheduleExport(this.graph.export() as SerializedGraph);
  }

  /**
   * Graceful shutdown per Plan 03 §"Behavior surprises". The order is:
   *   1. `await exporter.flush()` — drains any pending debounced write
   *      (NOT fire-and-forget; we need the final mutation on disk).
   *   2. `await persistence.persistGraph(snapshot)` — durable LevelDB
   *      write of the final snapshot (the runtime cache).
   *   3. `await persistence.close()` — close the LevelDB handle.
   *
   * Step 2 is skipped when the store was constructed with
   * `persistOnClose: false` (a read-only open — see the option's docs).
   * Step 1 is kept unconditionally: `flush()` only writes when a
   * mutation actually scheduled an export, so it is already a no-op on a
   * pure read, and skipping it would silently drop a pending write if a
   * caller ever passed the flag on a store it did mutate.
   */
  async close(): Promise<void> {
    await this.exporter.flush();
    if (this.initialized && this.persistOnClose) {
      try {
        await this.persistence.persistGraph(
          this.graph.export() as SerializedGraph,
        );
      } catch {
        // LevelDB closed early — tolerate
      }
    }
    try {
      await this.persistence.close();
    } catch {
      // already closed — tolerate
    }
    this.initialized = false;
  }
}

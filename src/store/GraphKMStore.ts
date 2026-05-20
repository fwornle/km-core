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
}

/**
 * GraphKMStore — composition class wrapping Graphology in-memory graph
 * with LevelDB persistence and per-domain JSON export, exposing the
 * D-14 repository API (`putEntity`, `getEntity`, `deleteEntity`,
 * `findByOntologyClass`, `addRelation`, `findRelations`, `batch`,
 * `iterate`, `exportJson`, `mergeAttributes`, `restore`, `open`,
 * `close`).
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
  private initialized = false;

  constructor(opts: GraphKMStoreOptions) {
    super();
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
        await this.batch([
          { type: 'putEntity', entity: closedOld },
          { type: 'putEntity', entity },
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
   * undefined`) is what preserves Phase 37/38 backward compatibility:
   * none of the existing 33 tests set `validUntil`, so the new active-
   * only default does not regress them. Entities WITH `validUntil` are
   * active iff `new Date(validUntil).getTime() > nowMs`.
   */
  private isActive(entity: Entity, nowMs: number): boolean {
    if (entity.validUntil === undefined) return true;
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
    const after: Entity[] = [];
    cursor = id;
    while (cursor !== undefined) {
      let next: EntityId | undefined;
      this.graph.forEachOutEdge(cursor, (_key, attrs, _src, tgt) => {
        const r = attrs as Relation;
        if (r.type === 'SUPERSEDED_BY' && !visited.has(tgt as EntityId)) {
          next = tgt as EntityId;
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
        // Ontology check (skipped by individual `skipOntologyCheck` flag
        // is NOT supported in batch — batch is strict-by-default).
        this.validator.validate(op.entity.entityType);
        if (op.entity.id !== undefined && op.entity.id !== null) {
          parseEntityId(op.entity.id as unknown as string);
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
   */
  async close(): Promise<void> {
    await this.exporter.flush();
    if (this.initialized) {
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

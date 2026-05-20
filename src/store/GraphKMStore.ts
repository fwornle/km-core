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
  type OntologyValidator,
} from '../validation/ontology.js';
import type {
  Entity,
  Relation,
  Layer,
  SerializedGraph,
} from '../types/entity.js';
import type { EntityId } from '../ids/branded.js';
import type { BatchOp, FilterObject } from './types.js';

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
    this.validator = opts.ontologyValidator ?? noopOntologyValidator;
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
   * Emits `entity:put` and schedules a debounced export.
   */
  async putEntity(
    e: Partial<Entity> & { name: string; entityType: string },
    opts?: { skipOntologyCheck?: boolean },
  ): Promise<EntityId> {
    const trusted = opts?.skipOntologyCheck === true;

    // D-19 validation — skipped on the trusted path.
    if (!trusted) {
      this.validator.validate(e.entityType);
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
    // byte-equal canonical output. On the strict path, fill defaults.
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
   * Find every entity whose `entityType` OR `ontologyClass` matches.
   * Both fields are checked because 37-PATTERNS notes OKM keeps both
   * in transit (entityType is authoritative; ontologyClass is the
   * legacy alias retained for BC during Phase 38).
   */
  async findByOntologyClass(cls: string): Promise<Entity[]> {
    const matches: Entity[] = [];
    for (const nodeId of this.graph.nodes()) {
      const entity = this.graph.getNodeAttributes(nodeId) as Entity;
      if (entity.entityType === cls || entity.ontologyClass === cls) {
        matches.push(entity);
      }
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
        await this.putEntity(op.entity);
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
   */
  async *iterate(filter?: FilterObject): AsyncIterable<Entity> {
    for (const nodeId of this.graph.nodes()) {
      const entity = this.graph.getNodeAttributes(nodeId) as Entity;
      if (this.matches(entity, filter)) {
        yield entity;
      }
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

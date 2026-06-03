// Phase 44 (44-CONTEXT-amendment.md): wire-serializers adapter — domain → OKM wire shape.
//
// PURPOSE:
//   km-core holds entities / relations / stats in the rich in-process "domain"
//   shape (Phase 39 D-30 top-level provenance, Phase 41 D-13 legacyId,
//   Phase 42 D-52 embedding, validFrom / validUntil / supersedes). The HTTP
//   wire surface is OKM's `tests/integration/rest-contract.test.ts:94-287`
//   shape (provenance nested under `metadata.provenance`, no top-level
//   legacyId / embedding / validFrom / validUntil / supersedes; relations
//   shaped as graphology edges with `{key, source, target, attributes}`).
//
//   This module is the bridge: pure functions that project domain shapes onto
//   the wire shape. Plan 44-06 handlers wrap their response data in these
//   functions before emitting the `{success:true,data:...}` envelope.
//
// PATTERN: lifted from `src/adapters/observation-view.ts` (Plan 44-05) — pure,
//   synchronous, no I/O, no diagnostic emission, type-only imports.
//
// no-console-log: this module is PURE — no I/O, no async, no side effects, no
// diagnostic emission. Any diagnostic logging lives in the caller (Plan 44-06
// router error wrapper).
//
// no-evolutionary-names: file is EXACTLY `wire-serializers.ts`. No v2 /
// enhanced / new variants.

import type { Entity, Relation } from '../types/entity.js';
import type {
  EntityWire,
  RelationWire,
  StatsWire,
  EntityProvenance,
} from '../api/contracts.js';

// ----------------------------------------------------------------------------
// entityToWire
// ----------------------------------------------------------------------------

/**
 * Project an in-process domain Entity onto the OKM wire shape.
 *
 * The TS `Entity` type (`src/types/entity.ts`) already nests provenance
 * inside `metadata.provenance` per the Phase 39 `EntityProvenance` interface
 * — top-level provenance was a misconception of the original EntitySchema.
 * This serializer therefore preserves `metadata` verbatim AND strips the
 * in-process-only top-level fields that should not cross the HTTP boundary.
 *
 * What's kept:
 *   - id, name, entityType, ontologyClass, layer, description,
 *     createdAt, updatedAt
 *   - metadata bag (preserved verbatim — provenance, if present, is already
 *     inside metadata.provenance per `EntityProvenance`)
 *
 * What's stripped from the wire shape:
 *   - legacyId — Phase 41 origin-system bridge; in-process only
 *   - embedding — Phase 42 D-52 vector; rebuilt from this store on demand
 *   - validFrom / validUntil / supersedes — Phase 39 lineage; in-process only
 *
 * If a non-canonical caller hands in an entity-shaped record with top-level
 * `createdBy` / `lastConfirmedBy` / `confirmationCount` (e.g. migrated
 * fixtures from Plan 44-09's discovery), those keys are folded into
 * `metadata.provenance` when not already present there. This makes the
 * serializer robust to both shapes that exist in the wild.
 *
 * @param e — a domain Entity (typically as iterated from GraphKMStore), or
 *           an Entity-shaped record with top-level provenance fields.
 * @returns the wire-shape Entity (OKM `EntityWire` per contracts.ts §2).
 */
export function entityToWire(e: Entity): EntityWire {
  // Cast once to a loose record so we can defensively look for any top-level
  // provenance fields a non-canonical caller might have set (the TS Entity
  // type does not declare them, but tests / fixtures may carry them).
  const eRec = e as unknown as Record<string, unknown>;

  // Start from the existing metadata bag (preserving all consumer-supplied
  // keys, including `domain` and any pre-existing `provenance`).
  const incomingMeta = (e.metadata ?? {}) as Record<string, unknown>;
  const outMeta: Record<string, unknown> = { ...incomingMeta };

  // If metadata already has a provenance object, preserve it as-is. Otherwise,
  // if the caller supplied top-level provenance keys (non-canonical but
  // observed in the wild), fold them into a single EntityProvenance object.
  const existingProvenance = incomingMeta.provenance as
    | EntityProvenance
    | undefined;
  if (existingProvenance === undefined) {
    const createdByT = eRec.createdBy as EntityProvenance['createdBy'] | undefined;
    const lastConfirmedByT = eRec.lastConfirmedBy as
      | EntityProvenance['lastConfirmedBy']
      | undefined;
    const confirmationCountT = eRec.confirmationCount as number | undefined;
    if (createdByT !== undefined && lastConfirmedByT !== undefined) {
      // Build provenance object only when all required fields are present;
      // partial provenance would fail downstream Zod parse against the
      // EntityProvenanceSchema (createdBy + lastConfirmedBy + count all required).
      outMeta.provenance = {
        createdBy: createdByT,
        lastConfirmedBy: lastConfirmedByT,
        confirmationCount: confirmationCountT ?? 0,
      } satisfies EntityProvenance;
    }
  }

  // Build the wire entity. Optional ontologyClass passes through only when
  // present (omitting the key entirely when undefined keeps fixture byte-equal).
  const wire: EntityWire = {
    id: e.id as string,
    name: e.name,
    entityType: e.entityType,
    layer: e.layer,
    description: e.description,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    metadata: outMeta as EntityWire['metadata'],
  };
  if (e.ontologyClass !== undefined) {
    wire.ontologyClass = e.ontologyClass;
  }
  return wire;
}

// ----------------------------------------------------------------------------
// relationToWire
// ----------------------------------------------------------------------------

/**
 * Domain Relation expanded with the graph-store-assigned edge key (if known).
 * The graph key is the deterministic edge id (`<from>|<to>|<type>` by
 * convention; graphology may assign its own `geid_…` style id when the key
 * was not supplied at addEdge time).
 */
export interface RelationWithKey extends Relation {
  /** Graphology-assigned edge key. When absent, `relationToWire` synthesizes
   *  one as `<from>|<to>|<type>`. */
  key?: string;
}

/**
 * Project an in-process domain Relation onto the OKM graphology-edge wire shape.
 *
 * Field map:
 *   - key       = `r.key ?? `${r.from}|${r.to}|${r.type}`` (synthetic when absent)
 *   - source    = r.from
 *   - target    = r.to
 *   - attributes.type      = r.type
 *   - attributes.metadata  = r.metadata ?? {}
 *   - attributes.createdAt = r.createdAt ?? '' (ISO timestamp; empty fallback
 *                            preserves the contract that the field is always
 *                            a string on the wire, even when the domain
 *                            relation predates Phase 39's stamping invariant)
 *
 * @param r — a domain Relation, optionally with its graphology edge key.
 * @returns the wire-shape Relation (OKM `RelationWire`).
 */
export function relationToWire(r: RelationWithKey): RelationWire {
  const key = r.key ?? `${r.from as string}|${r.to as string}|${r.type}`;
  return {
    key,
    source: r.from as string,
    target: r.to as string,
    attributes: {
      type: r.type,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
      createdAt: r.createdAt ?? '',
    },
  };
}

// ----------------------------------------------------------------------------
// statsToWire
// ----------------------------------------------------------------------------

/**
 * Loose input shape for stats projection. All fields except `nodes` and
 * `edges` are optional; the projector applies sensible defaults (0 for
 * counts, epoch ISO for lastUpdated, null for activeSnapshot). This matches
 * how OKM's `/api/stats` handler accretes the response from `analyzeConnectivity`
 * + entity counts.
 */
export interface GraphStatsLike {
  /** Total node count (e.g. graphology `graph.order`). */
  nodes: number;
  /** Total edge count (e.g. graphology `graph.size`). */
  edges: number;
  evidenceCount?: number;
  patternCount?: number;
  orphanCount?: number;
  islandCount?: number;
  componentCount?: number;
  connectivity?: number;
  /** ISO timestamp. Defaults to epoch when absent. */
  lastUpdated?: string;
  /** Active-snapshot identifier or null. NEVER undefined — defaults to null
   *  to satisfy the wire `z.unknown().nullable()` (not `.optional()`). */
  activeSnapshot?: unknown;
}

/**
 * Project a graph-stats-like bag onto the OKM `StatsWire` shape.
 *
 * Defaults applied:
 *   - evidenceCount / patternCount / orphanCount / islandCount /
 *     componentCount / connectivity → 0 when absent
 *   - lastUpdated → `new Date(0).toISOString()` (epoch) when absent
 *   - activeSnapshot → null when absent (must be null, never undefined,
 *     per OKM wire `z.unknown().nullable()`)
 *
 * @param s — partial stats bag (nodes + edges required).
 * @returns wire-shape Stats (OKM `StatsWire`).
 */
export function statsToWire(s: GraphStatsLike): StatsWire {
  return {
    nodes: s.nodes,
    edges: s.edges,
    evidenceCount: s.evidenceCount ?? 0,
    patternCount: s.patternCount ?? 0,
    orphanCount: s.orphanCount ?? 0,
    islandCount: s.islandCount ?? 0,
    componentCount: s.componentCount ?? 0,
    connectivity: s.connectivity ?? 0,
    lastUpdated: s.lastUpdated ?? new Date(0).toISOString(),
    activeSnapshot: s.activeSnapshot ?? null,
  };
}

// Canonical KM-Core entity / relation / serialized-graph types.
//
// SOURCE: adopted verbatim (with the 4 deltas listed below) from OKM's
//   _work/rapid-automations/integrations/operational-knowledge-management/
//   src/types/entity.ts
// RESEARCH §"Pattern 1: Canonical Entity Type" identifies OKM as the strict
// superset baseline; Phase 39 will populate the provenance subtypes against
// real ingestion runs but they MUST be declared here so consumers can type
// against the final shape today.
//
// DELTAS applied (per 37-PATTERNS §src/types/entity.ts DELTAS):
//   1. `id` is branded as `EntityId` (D-11) and `supersedes?: EntityId` added.
//   2. `Edge` renamed to `Relation`, with explicit `from: EntityId; to: EntityId`
//      moved INSIDE the type (D-14's `addRelation(r: Relation)` signature
//      collapses OKM's `addEdge(source, target, edge)` into one payload).
//   3. `legacyId?: { system: 'A' | 'B' | 'C'; id: string }` added per D-13
//      so Phase 39 backfill can record the origin system + native id when
//      legacy entities are stamped with their first UUIDv7.
//   4. Drop any `bin`-related types (KM-Core is library-only — no CLI).
//      OKM source had none, so this is a documentation-level no-op.
//
// `SerializedGraph` is what `graphology.MultiDirectedGraph.export()` returns
// and what `import()` consumes; it must match Graphology's shape verbatim.

import type { EntityId } from '../ids/branded.js';

export type Layer = 'evidence' | 'pattern';

/** Tracks which LLM model/run created or last confirmed an entity */
export interface ProvenanceStamp {
  provider: string;
  model: string;
  runId: string;
  timestamp: string;
}

/** Provenance tracking stored in Entity.metadata.provenance */
export interface EntityProvenance {
  createdBy: ProvenanceStamp;
  lastConfirmedBy: ProvenanceStamp;
  confirmationCount: number;
}

/** Confirmation record: another run that produced identical text */
export interface SegmentConfirmation {
  runId: string;
  provider: string;
  model: string;
  timestamp: string;
}

/**
 * Per-segment provenance: tracks which ingestion run, LLM provider/model,
 * and quality level produced each description segment.
 *
 * Stored in Entity.metadata.descriptionSegments[].
 * When a subsequent run produces identical text, a confirmation is appended
 * to the `confirmations` array rather than creating a duplicate segment.
 *
 * Confidence heuristic:
 *   base 0.5 (single run)
 *   +0.15 per confirmation by a different model
 *   +0.05 per confirmation by the same model
 *   +0.10 bonus if confirmed by a "thorough" quality run
 *   cap at 1.0
 */
export interface DescriptionSegment {
  /** The description text for this segment */
  text: string;
  /** Ingestion run that first produced this segment */
  runId: string;
  /** LLM provider (e.g. 'copilot', 'groq') */
  provider: string;
  /** LLM model (e.g. 'llama-3.3-70b-versatile') */
  model: string;
  /** Quality level of the extraction run */
  quality: 'fast' | 'standard' | 'thorough';
  /** ISO timestamp when segment was first created */
  timestamp: string;
  /** Subsequent runs that produced identical text */
  confirmations: SegmentConfirmation[];
}

/** Records a single entity-resolution merge event (stored in Entity.metadata.resolutionHistory[]) */
export interface ResolutionRecord {
  /** Composite key of the entity that was merged away (e.g. "evidence:uuid") */
  mergedEntityId: string;
  /** Display name of the merged-away entity */
  mergedEntityName: string;
  /** Ontology class shared by survivor and duplicate */
  ontologyClass: string;
  /** ISO timestamp when the resolution merge occurred */
  timestamp: string;
}

export interface Entity {
  /** Branded UUIDv7 identifier (D-08 / D-11). Produced by `mintEntityId()`
   *  on first store, or validated via `parseEntityId(s)` when caller-supplied. */
  id: EntityId;
  name: string;
  entityType: string;
  ontologyClass?: string;
  layer: Layer;
  description: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
  /** ISO timestamp: when this entity became valid (set at creation time) */
  validFrom?: string;
  /** ISO timestamp: when this entity was superseded or expired (set by supersession or manual expiry) */
  validUntil?: string;
  /** When this entity replaced a prior one, the `EntityId` of the predecessor (D-11 delta). */
  supersedes?: EntityId;
  /** Origin-system bridge populated by the Phase 39 backfill (D-13). */
  legacyId?: { system: 'A' | 'B' | 'C'; id: string };
}

/**
 * Typed relation between two entities. Renamed from OKM's `Edge` and
 * extended with explicit `from`/`to` `EntityId` endpoints (D-14 delta)
 * so a single `addRelation(r: Relation)` call carries the full payload.
 */
export interface Relation {
  type: string;
  from: EntityId;
  to: EntityId;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  /** ISO timestamp: when this relation became valid */
  validFrom?: string;
  /** ISO timestamp: when this relation was superseded or expired */
  validUntil?: string;
}

/**
 * The wire format produced by `graphology.MultiDirectedGraph.export()` and
 * consumed by `import()`. Adopted verbatim from OKM (lines 96-107 of the
 * source); Phase 39 round-trip fixtures lock this shape in.
 */
export interface SerializedGraph {
  attributes: Record<string, unknown>;
  options: { allowSelfLoops: boolean; multi: boolean; type: string };
  nodes: Array<{ key: string; attributes: Entity }>;
  edges: Array<{
    key: string;
    source: string;
    target: string;
    attributes: Relation;
    undirected?: boolean;
  }>;
}

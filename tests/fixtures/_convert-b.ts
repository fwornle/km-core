// One-time converter: B's `{entities, relations, metadata}` snapshot shape
// → Graphology `SerializedGraph` `{attributes, options, nodes, edges}` shape.
//
// B (coding's GraphKnowledgeExporter) writes the legacy semantic-analysis shape;
// the 3 C exports are already in Graphology shape. This converter exists ONLY so
// the Wave-0 round-trip parity test can load all four fixtures into a single
// MultiDirectedGraph. It disappears in Phase 42 once B's exporter is rewritten
// against KM-Core (which natively emits Graphology shape).
//
// Mapping (mirrors what B's GraphKnowledgeExporter._buildGraph builds in-process):
//   entities[].id           → nodes[].key
//   entities[]              → nodes[].attributes (id duplicated inside attrs, harmless)
//   relations[].from        → edges[].source
//   relations[].to          → edges[].target
//   relations[].relationType→ edges[].attributes.type
//   relations[].metadata    → edges[].attributes.metadata

import type { SerializedGraph as GraphologySerializedGraph } from 'graphology-types';

/** B's native snapshot shape (coding's .data/knowledge-export/coding.json). */
export interface BSnapshot {
  entities: Array<Record<string, unknown> & { id: string }>;
  relations: Array<{
    from: string;
    to: string;
    relationType: string;
    metadata?: Record<string, unknown>;
  }>;
  metadata?: Record<string, unknown>;
}

/**
 * Normalize B's `{entities, relations, metadata}` snapshot into a Graphology
 * `SerializedGraph`. Multi-directed so it tolerates parallel relations between
 * the same pair (B does emit those — e.g. multiple `uses` edges with different
 * metadata).
 *
 * B's relations reference entities by `name`, not by `id` (legacy coding/
 * GraphKnowledgeExporter behavior). Graphology requires edge endpoints to
 * match node keys exactly, so we use the entity `name` as the node `key`
 * (the `id` field is preserved inside `attributes` for CORE-03 ID survival).
 *
 * Round-trip parity contract: the round-trip test compares the converted
 * SerializedGraph (output of this function) against the per-domain JSON
 * export reassembled. Both sides must agree on the same shape — that's why
 * we use `name` as `key` here AND why the test's `originalIds` set is built
 * from `serialized.nodes.map(n => n.key)` (i.e. names, not legacy nanoids).
 */
export function convertBToGraphology(b: BSnapshot): GraphologySerializedGraph {
  return {
    attributes: { ...(b.metadata ?? {}), _convertedFrom: 'b-snapshot-v1' },
    options: { type: 'directed', multi: true, allowSelfLoops: true },
    nodes: b.entities.map(e => ({
      key: (e as { name?: string }).name ?? e.id,
      attributes: e,
    })),
    edges: b.relations.map((r, idx) => ({
      key: `b-rel-${idx}`,
      source: r.from,
      target: r.to,
      attributes: {
        type: r.relationType,
        ...(r.metadata !== undefined ? { metadata: r.metadata } : {}),
      },
      undirected: false,
    })),
  };
}

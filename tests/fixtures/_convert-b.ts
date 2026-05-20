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
 */
export function convertBToGraphology(b: BSnapshot): GraphologySerializedGraph {
  return {
    attributes: { ...(b.metadata ?? {}), _convertedFrom: 'b-snapshot-v1' },
    options: { type: 'directed', multi: true, allowSelfLoops: true },
    nodes: b.entities.map(e => ({
      key: e.id,
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

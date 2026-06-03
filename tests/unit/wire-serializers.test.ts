// Phase 44 (44-CONTEXT-amendment.md) — wire-serializers adapter unit tests.
//
// Verifies the three pure-function serializers in
// `src/adapters/wire-serializers.ts`:
//   - entityToWire   — packs domain provenance into metadata.provenance,
//                      strips top-level legacyId / embedding / validFrom /
//                      validUntil / supersedes
//   - relationToWire — emits graphology edge envelope {key, source, target,
//                      attributes:{type, metadata, createdAt}}; synthesizes
//                      key when absent
//   - statsToWire    — graceful defaults; activeSnapshot must be null
//                      (never undefined)
//
// No I/O, no async. Bound assertions against the inferred wire types so a
// drift in contracts.ts shows up here as a TS error.
//
// no-console-log: pure assertions; no diagnostic emission.

import { describe, test, expect } from 'vitest';
import {
  entityToWire,
  relationToWire,
  statsToWire,
  type RelationWithKey,
} from '../../src/adapters/wire-serializers.js';
import {
  EntityWireSchema,
  RelationWireSchema,
  StatsWireSchema,
} from '../../src/api/contracts.js';
import type { Entity, Relation } from '../../src/types/entity.js';
import type { EntityId } from '../../src/ids/branded.js';

const BASE_ENTITY: Entity = {
  id: '019e8e47-0000-7000-8000-000000000001' as EntityId,
  name: 'TestComponent',
  entityType: 'Component',
  ontologyClass: 'Component',
  layer: 'evidence',
  description: 'a test',
  createdAt: '2026-06-03T12:00:00.000Z',
  updatedAt: '2026-06-03T12:00:00.000Z',
  metadata: {},
};

describe('entityToWire — domain → wire projection', () => {
  test('minimal entity round-trips: id/name/entityType/layer/description/createdAt/updatedAt preserved', () => {
    const wire = entityToWire(BASE_ENTITY);
    expect(wire.id).toBe(BASE_ENTITY.id);
    expect(wire.name).toBe('TestComponent');
    expect(wire.entityType).toBe('Component');
    expect(wire.layer).toBe('evidence');
    expect(wire.description).toBe('a test');
    expect(wire.createdAt).toBe('2026-06-03T12:00:00.000Z');
    expect(wire.updatedAt).toBe('2026-06-03T12:00:00.000Z');
    // Wire schema validates
    expect(() => EntityWireSchema.parse(wire)).not.toThrow();
  });

  test('packs top-level provenance fields into metadata.provenance', () => {
    // Top-level provenance is not part of the canonical TS Entity type
    // (the type carries provenance inside metadata.provenance), but
    // legacy / migrated fixtures observed in the wild have them at the
    // top level. The serializer must handle either shape — cast accordingly.
    const e = {
      ...BASE_ENTITY,
      createdBy: {
        provider: 'anthropic',
        model: 'claude',
        runId: 'r1',
        timestamp: '2026-06-03T12:00:00.000Z',
      },
      lastConfirmedBy: {
        provider: 'anthropic',
        model: 'claude',
        runId: 'r2',
        timestamp: '2026-06-03T12:05:00.000Z',
      },
      confirmationCount: 3,
    } as unknown as Entity;
    const wire = entityToWire(e);
    expect(wire.metadata.provenance).toEqual({
      createdBy: {
        provider: 'anthropic',
        model: 'claude',
        runId: 'r1',
        timestamp: '2026-06-03T12:00:00.000Z',
      },
      lastConfirmedBy: {
        provider: 'anthropic',
        model: 'claude',
        runId: 'r2',
        timestamp: '2026-06-03T12:05:00.000Z',
      },
      confirmationCount: 3,
    });
    expect(() => EntityWireSchema.parse(wire)).not.toThrow();
  });

  test('strips top-level legacyId from wire output', () => {
    const e: Entity = {
      ...BASE_ENTITY,
      legacyId: { system: 'A', id: 'sqlite-rowid-42' },
    };
    const wire = entityToWire(e);
    expect((wire as unknown as Record<string, unknown>).legacyId).toBeUndefined();
    expect(() => EntityWireSchema.parse(wire)).not.toThrow();
  });

  test('strips top-level embedding from wire output', () => {
    const e: Entity = {
      ...BASE_ENTITY,
      embedding: [0.1, 0.2, 0.3],
    };
    const wire = entityToWire(e);
    expect((wire as unknown as Record<string, unknown>).embedding).toBeUndefined();
    expect(() => EntityWireSchema.parse(wire)).not.toThrow();
  });

  test('strips top-level validFrom/validUntil/supersedes from wire output', () => {
    const e: Entity = {
      ...BASE_ENTITY,
      validFrom: '2026-06-03T12:00:00.000Z',
      validUntil: '2026-06-04T12:00:00.000Z',
      supersedes: '019e8e47-0000-7000-8000-000000000000' as EntityId,
    };
    const wire = entityToWire(e);
    const wireRec = wire as unknown as Record<string, unknown>;
    expect(wireRec.validFrom).toBeUndefined();
    expect(wireRec.validUntil).toBeUndefined();
    expect(wireRec.supersedes).toBeUndefined();
    expect(() => EntityWireSchema.parse(wire)).not.toThrow();
  });

  test('preserves arbitrary metadata bag keys', () => {
    const e: Entity = {
      ...BASE_ENTITY,
      metadata: {
        domain: 'coding',
        customKey: 'custom-value',
        nested: { foo: 'bar' },
      },
    };
    const wire = entityToWire(e);
    expect(wire.metadata.domain).toBe('coding');
    expect((wire.metadata as Record<string, unknown>).customKey).toBe('custom-value');
    expect((wire.metadata as Record<string, unknown>).nested).toEqual({ foo: 'bar' });
    expect(() => EntityWireSchema.parse(wire)).not.toThrow();
  });

  test('preserves existing metadata.provenance when present (does not overwrite from top-level)', () => {
    const e = {
      ...BASE_ENTITY,
      metadata: {
        provenance: {
          createdBy: {
            provider: 'pre-existing',
            model: 'm1',
            runId: 'r1',
            timestamp: '2026-01-01T00:00:00.000Z',
          },
          lastConfirmedBy: {
            provider: 'pre-existing',
            model: 'm1',
            runId: 'r1',
            timestamp: '2026-01-01T00:00:00.000Z',
          },
          confirmationCount: 7,
        },
      },
      // Also set top-level — should be ignored (provenance already in metadata).
      createdBy: {
        provider: 'top-level',
        model: 'm2',
        runId: 'r2',
        timestamp: '2026-06-03T00:00:00.000Z',
      },
    } as unknown as Entity;
    const wire = entityToWire(e);
    expect(
      (wire.metadata.provenance as { createdBy: { provider: string } }).createdBy.provider,
    ).toBe('pre-existing');
    expect(
      (wire.metadata.provenance as { confirmationCount: number }).confirmationCount,
    ).toBe(7);
    expect(() => EntityWireSchema.parse(wire)).not.toThrow();
  });

  test('omits ontologyClass key entirely when undefined (byte-equal fixture support)', () => {
    const e: Entity = {
      ...BASE_ENTITY,
      ontologyClass: undefined,
    };
    const wire = entityToWire(e);
    expect('ontologyClass' in wire).toBe(false);
    expect(() => EntityWireSchema.parse(wire)).not.toThrow();
  });
});

describe('relationToWire — domain → graphology edge envelope', () => {
  const BASE_RELATION: RelationWithKey = {
    type: 'derivedFrom',
    from: '019e8e47-0000-7000-8000-000000000001' as EntityId,
    to: '019e8e47-0000-7000-8000-000000000002' as EntityId,
    createdAt: '2026-06-03T12:00:00.000Z',
    metadata: { confidence: 0.95 },
  };

  test('emits graphology edge envelope shape with caller-supplied key', () => {
    const r: RelationWithKey = { ...BASE_RELATION, key: 'edge-abc' };
    const wire = relationToWire(r);
    expect(wire.key).toBe('edge-abc');
    expect(wire.source).toBe('019e8e47-0000-7000-8000-000000000001');
    expect(wire.target).toBe('019e8e47-0000-7000-8000-000000000002');
    expect(wire.attributes.type).toBe('derivedFrom');
    expect(wire.attributes.metadata).toEqual({ confidence: 0.95 });
    expect(wire.attributes.createdAt).toBe('2026-06-03T12:00:00.000Z');
    expect(() => RelationWireSchema.parse(wire)).not.toThrow();
  });

  test('synthesizes key when absent: `<from>|<to>|<type>`', () => {
    const r: RelationWithKey = { ...BASE_RELATION };
    const wire = relationToWire(r);
    expect(wire.key).toBe(
      '019e8e47-0000-7000-8000-000000000001|019e8e47-0000-7000-8000-000000000002|derivedFrom',
    );
    expect(() => RelationWireSchema.parse(wire)).not.toThrow();
  });

  test('defaults metadata to {} when absent', () => {
    const r: RelationWithKey = {
      type: 'mentions',
      from: 'a' as EntityId,
      to: 'b' as EntityId,
      createdAt: '2026-06-03T12:00:00.000Z',
    };
    const wire = relationToWire(r);
    expect(wire.attributes.metadata).toEqual({});
    expect(() => RelationWireSchema.parse(wire)).not.toThrow();
  });

  test('defaults createdAt to empty string when absent (still a string on the wire)', () => {
    const r: RelationWithKey = {
      type: 'mentions',
      from: 'a' as EntityId,
      to: 'b' as EntityId,
    } as RelationWithKey;
    const wire = relationToWire(r);
    expect(typeof wire.attributes.createdAt).toBe('string');
    expect(wire.attributes.createdAt).toBe('');
    expect(() => RelationWireSchema.parse(wire)).not.toThrow();
  });
});

describe('statsToWire — graceful defaults + Zod conformance', () => {
  test('round-trips a fully-populated stats bag', () => {
    const wire = statsToWire({
      nodes: 100,
      edges: 250,
      evidenceCount: 60,
      patternCount: 40,
      orphanCount: 5,
      islandCount: 2,
      componentCount: 3,
      connectivity: 0.97,
      lastUpdated: '2026-06-03T12:00:00.000Z',
      activeSnapshot: { tag: 'snapshot/foo' },
    });
    expect(wire.nodes).toBe(100);
    expect(wire.edges).toBe(250);
    expect(wire.evidenceCount).toBe(60);
    expect(wire.patternCount).toBe(40);
    expect(wire.activeSnapshot).toEqual({ tag: 'snapshot/foo' });
    expect(() => StatsWireSchema.parse(wire)).not.toThrow();
  });

  test('defaults all-optional fields when only nodes/edges supplied', () => {
    const wire = statsToWire({ nodes: 0, edges: 0 });
    expect(wire.evidenceCount).toBe(0);
    expect(wire.patternCount).toBe(0);
    expect(wire.orphanCount).toBe(0);
    expect(wire.islandCount).toBe(0);
    expect(wire.componentCount).toBe(0);
    expect(wire.connectivity).toBe(0);
    expect(wire.lastUpdated).toBe('1970-01-01T00:00:00.000Z');
    expect(() => StatsWireSchema.parse(wire)).not.toThrow();
  });

  test('activeSnapshot defaults to null (NEVER undefined — z.unknown().nullable())', () => {
    const wire = statsToWire({ nodes: 5, edges: 4 });
    expect(wire.activeSnapshot).toBeNull();
    // Verify the literal property exists with `null` (not omitted) — the schema
    // is `z.unknown().nullable()` which means null is allowed but undefined is not.
    expect('activeSnapshot' in wire).toBe(true);
    expect(() => StatsWireSchema.parse(wire)).not.toThrow();
  });

  test('null activeSnapshot passes wire-schema parse', () => {
    const wire = statsToWire({ nodes: 5, edges: 4, activeSnapshot: null });
    expect(wire.activeSnapshot).toBeNull();
    expect(() => StatsWireSchema.parse(wire)).not.toThrow();
  });
});

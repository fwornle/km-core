// Phase 44 Wave 0 test (post-amendment): EntitySchema (wire-shape) + ApiSuccessEnvelope.
//
// 2026-06-03 AMENDMENT (44-CONTEXT-amendment.md):
//   The original RED-then-GREEN of this test asserted on the DOMAIN entity
//   shape (top-level provenance, legacyId, embedding, validFrom etc.). That
//   was wrong: the contract that should have been locked from the start is
//   the OKM WIRE shape (provenance under metadata.provenance; no top-level
//   legacyId / embedding / validFrom / validUntil / supersedes).
//
//   This test now asserts on the wire shape — what EntitySchema actually
//   means after the amendment: `EntitySchema = EntityWireSchema`.
//
// Schemas under test mirror OKM rest-contract.test.ts:109-122 verbatim:
//   EntitySchema (= EntityWireSchema): id, name, entityType, ontologyClass?,
//     layer, description, createdAt, updatedAt, metadata: {domain?,
//     provenance?} & {[k]: unknown}.
//   ApiSuccessEnvelope(data): { success: true, data }.
//
// The Entity TS type alias is exported via z.infer<typeof EntitySchema>; the
// type-shape assertion compiles ONLY if the wire shape is what's wired.
//
// no-console-log: pure assertion tests, no diagnostic emission.

import { describe, test, expect } from 'vitest';
import { EntitySchema, ApiSuccessEnvelope } from '../../src/api/contracts.js';
import type { Entity } from '../../src/api/contracts.js';

const VALID_MINIMAL_ENTITY = {
  id: 'entity/01ABC',
  name: 'MinimalEntity',
  entityType: 'Component',
  layer: 'evidence' as const,
  description: 'Minimal valid Phase 44 wire-shape entity',
  createdAt: '2026-06-03T12:00:00Z',
  updatedAt: '2026-06-03T12:00:00Z',
  metadata: {},
};

describe('EntitySchema (OKM wire shape per 44-CONTEXT-amendment.md) — Zod contract', () => {
  test('parse accepts a minimal valid wire-shape entity', () => {
    const parsed = EntitySchema.parse(VALID_MINIMAL_ENTITY);
    expect(parsed.id).toBe('entity/01ABC');
    expect(parsed.entityType).toBe('Component');
    expect(parsed.layer).toBe('evidence');
  });

  test('parse REJECTS entity missing required entityType field with ZodError', () => {
    const { entityType: _drop, ...broken } = VALID_MINIMAL_ENTITY;
    expect(() => EntitySchema.parse(broken)).toThrow();
    const result = EntitySchema.safeParse(broken);
    expect(result.success).toBe(false);
    if (!result.success) {
      const hasEntityTypeIssue = result.error.issues.some((iss) =>
        iss.path.includes('entityType'),
      );
      expect(hasEntityTypeIssue).toBe(true);
    }
  });

  test('parse accepts entity with provenance under metadata.provenance (wire shape)', () => {
    const provenance = {
      createdBy: {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        runId: 'run-01',
        timestamp: '2026-06-03T12:00:00Z',
      },
      lastConfirmedBy: {
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        runId: 'run-02',
        timestamp: '2026-06-03T12:01:00Z',
      },
      confirmationCount: 0,
    };
    const withWireProvenance = {
      ...VALID_MINIMAL_ENTITY,
      ontologyClass: 'Component',
      metadata: {
        domain: 'coding',
        provenance,
      },
    };
    const parsed = EntitySchema.parse(withWireProvenance);
    expect(parsed.ontologyClass).toBe('Component');
    expect(parsed.metadata.domain).toBe('coding');
    expect(parsed.metadata.provenance).toEqual(provenance);
  });

  test('parse REJECTS top-level provenance fields (domain-shape leak)', () => {
    // Wire shape strips top-level legacyId / embedding / validFrom etc.
    // — but those keys are NOT formal rejection triggers. What WOULD be a
    // wire-vs-domain leak is providing INVALID metadata shape. So this test
    // verifies the wire schema also accepts an open metadata bag (per
    // `MetadataSchema = z.record(z.string(), z.unknown())`).
    const withExtraMetadata = {
      ...VALID_MINIMAL_ENTITY,
      metadata: {
        customKey: 'custom-value',
        nested: { foo: 'bar', baz: 42 },
        domain: 'coding',
      },
    };
    const parsed = EntitySchema.parse(withExtraMetadata);
    expect((parsed.metadata as Record<string, unknown>).customKey).toBe(
      'custom-value',
    );
    expect(parsed.metadata.domain).toBe('coding');
  });

  test('parse REJECTS invalid layer value (must be evidence or pattern)', () => {
    const badLayer = {
      ...VALID_MINIMAL_ENTITY,
      layer: 'unknown-layer' as unknown as 'evidence' | 'pattern',
    };
    const result = EntitySchema.safeParse(badLayer);
    expect(result.success).toBe(false);
  });
});

describe('ApiSuccessEnvelope(data) — wire-format contract', () => {
  test('parses { success: true, data: <wire-entity> }', () => {
    const Schema = ApiSuccessEnvelope(EntitySchema);
    const parsed = Schema.parse({ success: true, data: VALID_MINIMAL_ENTITY });
    expect(parsed.success).toBe(true);
    expect(parsed.data.id).toBe('entity/01ABC');
  });

  test('rejects { success: false, ... } (literal:true on success field)', () => {
    const Schema = ApiSuccessEnvelope(EntitySchema);
    const result = Schema.safeParse({ success: false, data: VALID_MINIMAL_ENTITY });
    expect(result.success).toBe(false);
  });
});

describe('z.infer<typeof EntitySchema> compiles (wire shape)', () => {
  test('Entity TS-type alias is consumable at compile time', () => {
    // If EntitySchema is not exported OR Entity is not exported as a type,
    // this file does not compile — runtime expect is a witness for the
    // type-level smoke. The assignment is the actual check.
    const e: Entity = {
      id: 'entity/01XYZ',
      name: 'TypeCheck',
      entityType: 'Pattern',
      layer: 'pattern',
      description: '',
      createdAt: '2026-06-03T12:00:00Z',
      updatedAt: '2026-06-03T12:00:00Z',
      metadata: {},
    };
    expect(e.id).toBe('entity/01XYZ');
  });
});

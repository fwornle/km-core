// Phase 44 Wave 0 RED stub: Zod contract schemas (EntitySchema, ApiSuccessEnvelope).
//
// CONTRACT WITH DOWNSTREAM PLANS:
//   This test imports from '../../src/api/contracts.js' which does NOT YET exist.
//   The module-not-found error against that path IS the expected RED state.
//   Plan 44-03 (Zod schemas codified verbatim from OKM's rest-contract.test.ts:94-167)
//   creates src/api/contracts.ts; this test goes GREEN once EntitySchema +
//   ApiSuccessEnvelope ship.
//
// Schemas under test mirror 44-RESEARCH.md §Pattern 2 (lines 207-251):
//   EntitySchema: Phase 39 entity shape (id, name, entityType, layer, description,
//     createdAt, updatedAt, metadata, + optional validFrom/validUntil/supersedes/
//     createdBy/lastConfirmedBy/confirmationCount/legacyId/embedding/ontologyClass).
//   ApiSuccessEnvelope(data): { success: true, data }.
//
// The Entity TS type alias is exported via z.infer<typeof EntitySchema>; the
// type-shape assertion (Test 5) compiles ONLY if Plan 44-03 exports it.
//
// no-console-log: pure assertion tests, no diagnostic emission.

import { describe, test, expect } from 'vitest';
// RED IMPORTS — Plan 44-03 deliverable. Do NOT collapse to try/catch.
import { EntitySchema, ApiSuccessEnvelope } from '../../src/api/contracts.js';
import type { Entity } from '../../src/api/contracts.js';

const VALID_MINIMAL_ENTITY = {
  id: 'entity/01ABC',
  name: 'MinimalEntity',
  entityType: 'Component',
  layer: 'evidence' as const,
  description: 'Minimal valid Phase 39 entity for Zod contract check',
  createdAt: '2026-06-03T12:00:00Z',
  updatedAt: '2026-06-03T12:00:00Z',
  metadata: {},
};

describe('EntitySchema (Phase 39 entity shape) — Zod contract', () => {
  test('parse accepts a minimal valid Phase 39 entity', () => {
    const parsed = EntitySchema.parse(VALID_MINIMAL_ENTITY);
    expect(parsed.id).toBe('entity/01ABC');
    expect(parsed.entityType).toBe('Component');
    expect(parsed.layer).toBe('evidence');
  });

  test('parse REJECTS entity missing required entityType field with ZodError', () => {
    const { entityType: _drop, ...broken } = VALID_MINIMAL_ENTITY;
    expect(() => EntitySchema.parse(broken)).toThrow();
    // Looser shape probe — safeParse returns success:false with issues array.
    const result = EntitySchema.safeParse(broken);
    expect(result.success).toBe(false);
    if (!result.success) {
      const hasEntityTypeIssue = result.error.issues.some((iss) =>
        iss.path.includes('entityType'),
      );
      expect(hasEntityTypeIssue).toBe(true);
    }
  });

  test('parse accepts entity with all optional Phase 39 fields', () => {
    const full = {
      ...VALID_MINIMAL_ENTITY,
      ontologyClass: 'Component',
      validFrom: '2026-06-03T12:00:00Z',
      validUntil: null,
      supersedes: [],
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
      legacyId: { system: 'A' as const, id: 'sqlite-rowid-42' },
      embedding: [0.1, 0.2, 0.3],
    };
    const parsed = EntitySchema.parse(full);
    expect(parsed.legacyId).toEqual({ system: 'A', id: 'sqlite-rowid-42' });
    expect(parsed.validUntil).toBeNull();
    expect(parsed.confirmationCount).toBe(0);
  });
});

describe('ApiSuccessEnvelope(data) — wire-format contract', () => {
  test('parses { success: true, data: <entity> }', () => {
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

describe('z.infer<typeof EntitySchema> compiles', () => {
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

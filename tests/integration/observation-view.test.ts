// Phase 44 Wave 0 RED stub: observation-view adapter — entity → legacy reshape.
//
// CONTRACT WITH DOWNSTREAM PLANS:
//   This test imports from '../../src/adapters/observation-view.js' which does
//   NOT YET exist. The module-not-found error against that path IS the expected
//   RED state. Plan 44-05 (A-4 typed-view adapter; see 44-RESEARCH.md §Pattern 3
//   lines 282-315 + 44-PATTERNS.md §observation-view.ts) makes this GREEN.
//
// What the adapter does:
//   km-core Entity (ontologyClass='Observation' | 'Digest' | 'Insight') →
//   LegacyObservation | LegacyDigest | LegacyInsight shape that A's dashboard
//   at :3032 reads via /api/coding/observations|digests|insights.
//
// Critical contracts (per Pattern 3 + Pitfall 2):
//   - legacyId.id is PREFERRED over entity.id (A-2 migration preserves SQLite rowid
//     in legacyId; downstream consumers identify rows by the SQLite id).
//   - metadata.summary → content; falls back to metadata.content; then entity.description.
//   - metadata.{agent,project,artifacts,session_id,quality} pass through with sane
//     defaults ('unknown', 'normal', empty array).
//   - validFrom → timestamp (the canonical Phase 39 temporal-anchor field).
//
// Pure tests — no tmpdir, no store, no I/O. Mappers are pure transforms.

import { describe, test, expect } from 'vitest';
// RED IMPORTS — Plan 44-05 deliverable.
import {
  observationToLegacy,
  digestToLegacy,
  insightToLegacy,
} from '../../src/adapters/observation-view.js';

// We avoid importing the Entity type because Plan 44-05's signature accepts
// `Entity` from km-core's existing types; the test inputs are intentionally
// loosely typed via `as any` to mirror what consumers pass in (untyped JSON
// from store.iterate()).
type AnyEntity = Record<string, unknown>;

describe('observationToLegacy — entity → LegacyObservation', () => {
  test('maps a fully populated entity with legacyId preference', () => {
    const entity: AnyEntity = {
      id: 'entity/01ABCD',
      name: 'an-observation',
      entityType: 'Observation',
      ontologyClass: 'Observation',
      layer: 'evidence',
      description: 'fallback-description',
      createdAt: '2026-01-02T03:04:05Z',
      updatedAt: '2026-01-02T03:04:05Z',
      validFrom: '2026-01-01T00:00:00Z',
      legacyId: { system: 'A', id: 'old-sqlite-id-42' },
      metadata: {
        agent: 'claude-opus-4-7',
        project: 'coding',
        summary: 'Real content from summary',
        artifacts: ['file1.ts', 'file2.ts'],
        session_id: 'sess-xyz',
        quality: 'high',
      },
    };

    const legacy = observationToLegacy(entity as never);
    expect(legacy.id).toBe('old-sqlite-id-42'); // legacyId.id WINS over entity.id
    expect(legacy.agent).toBe('claude-opus-4-7');
    expect(legacy.project).toBe('coding');
    expect(legacy.content).toBe('Real content from summary');
    expect(legacy.artifacts).toEqual(['file1.ts', 'file2.ts']);
    // Per Pattern 3 the timestamp is metadata.createdAt OR entity.validFrom OR ''.
    // No metadata.createdAt set here, so validFrom is the source.
    expect(legacy.timestamp).toBe('2026-01-01T00:00:00Z');
  });

  test('falls back: summary absent → content; content absent → entity.description', () => {
    const noSummaryHasContent: AnyEntity = {
      id: 'entity/01NOSUM',
      name: 'x',
      entityType: 'Observation',
      ontologyClass: 'Observation',
      layer: 'evidence',
      description: 'desc-fallback',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      metadata: { content: 'content-wins' },
    };
    expect(observationToLegacy(noSummaryHasContent as never).content).toBe('content-wins');

    const onlyDescription: AnyEntity = {
      ...noSummaryHasContent,
      metadata: {},
    };
    expect(observationToLegacy(onlyDescription as never).content).toBe('desc-fallback');
  });

  test('when legacyId absent, uses entity.id', () => {
    const entity: AnyEntity = {
      id: 'entity/01NOLEGACY',
      name: 'no-legacy',
      entityType: 'Observation',
      ontologyClass: 'Observation',
      layer: 'evidence',
      description: 'd',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      metadata: { agent: 'x', project: 'y', summary: 's' },
    };
    expect(observationToLegacy(entity as never).id).toBe('entity/01NOLEGACY');
  });
});

describe('digestToLegacy + insightToLegacy — analogous reshape', () => {
  test('digestToLegacy reshape smoke', () => {
    const digest: AnyEntity = {
      id: 'entity/01DIGEST',
      name: 'd',
      entityType: 'Digest',
      ontologyClass: 'Digest',
      layer: 'evidence',
      description: 'digest-desc',
      createdAt: '2026-02-01T00:00:00Z',
      updatedAt: '2026-02-01T00:00:00Z',
      validFrom: '2026-02-01T00:00:00Z',
      legacyId: { system: 'A', id: 'sqlite-digest-7' },
      metadata: {
        agent: 'a',
        project: 'p',
        summary: 'digest summary',
        artifacts: [],
      },
    };
    const out = digestToLegacy(digest as never);
    // The reshape must at minimum carry the legacyId.id preference.
    expect((out as { id: string }).id).toBe('sqlite-digest-7');
  });

  test('insightToLegacy reshape smoke', () => {
    const insight: AnyEntity = {
      id: 'entity/01INSIGHT',
      name: 'i',
      entityType: 'Insight',
      ontologyClass: 'Insight',
      layer: 'pattern',
      description: 'insight-desc',
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
      validFrom: '2026-03-01T00:00:00Z',
      legacyId: { system: 'A', id: 'sqlite-insight-3' },
      metadata: {
        agent: 'a',
        project: 'p',
        summary: 'insight summary',
        artifacts: [],
      },
    };
    const out = insightToLegacy(insight as never);
    expect((out as { id: string }).id).toBe('sqlite-insight-3');
  });
});

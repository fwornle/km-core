// Phase 41 Plan 02 (INT-01): pure row-to-Entity mapper unit tests.
//
// Covers Tests A-J from 41-02-PLAN.md <behavior>:
//   A. mapObservationRow → entityType + ontologyClass = 'Observation'
//   B. description = row.summary, createdAt = row.createdAt
//   C. entity.legacyId.system === 'A' AND entity.legacyId.id === row.id
//      (top-level Entity.legacyId per CF-D37 / entity.ts:147)
//   D. entity.metadata.subsystem === 'online' (SEPARATE from legacyId)
//   E. row.modifiedFiles === null → metadata.modifiedFiles === []
//   F. row.llm === null → metadata.llm absent
//   G. mapDigestRow → entityType + ontologyClass = 'Digest'; same legacyId + subsystem invariants
//   H. mapInsightRow → entityType + ontologyClass = 'Insight'; same invariants
//   I. name derivation — Observation: first non-empty line of summary (≤120 chars);
//      Digest: row.theme; Insight: row.topic
//   J. Purity — calling twice with same input returns equal-by-value entities
//
// Fixtures live at tests/fixtures/online-export/{observations,digests,insights}.json.
// Mappers are pure functions — no store, no I/O.

import { describe, test, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mapObservationRow,
  mapDigestRow,
  mapInsightRow,
  type ObservationRow,
  type DigestRow,
  type InsightRow,
} from '../../../src/adapters/online/mapper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadFixture<T>(name: 'observations' | 'digests' | 'insights'): T[] {
  const filepath = path.resolve(
    __dirname,
    '..',
    '..',
    'fixtures',
    'online-export',
    `${name}.json`,
  );
  return JSON.parse(fs.readFileSync(filepath, 'utf8')) as T[];
}

const observations: ObservationRow[] = loadFixture<ObservationRow>('observations');
const digests: DigestRow[] = loadFixture<DigestRow>('digests');
const insights: InsightRow[] = loadFixture<InsightRow>('insights');

describe('mapObservationRow', () => {
  test('Test A: returns Entity with entityType + ontologyClass = "Observation"', () => {
    const entity = mapObservationRow(observations[0]);
    expect(entity.entityType).toBe('Observation');
    expect(entity.ontologyClass).toBe('Observation');
  });

  test('Test B: description === row.summary AND createdAt === row.createdAt', () => {
    const row = observations[0];
    const entity = mapObservationRow(row);
    expect(entity.description).toBe(row.summary);
    expect(entity.createdAt).toBe(row.createdAt);
    expect(entity.validFrom).toBe(row.createdAt);
  });

  test('Test C: top-level entity.legacyId.system === "A" AND entity.legacyId.id === row.id', () => {
    const row = observations[0];
    const entity = mapObservationRow(row);
    expect(entity.legacyId).toBeDefined();
    expect(entity.legacyId?.system).toBe('A');
    expect(entity.legacyId?.id).toBe(row.id);
  });

  test('Test D: entity.metadata.subsystem === "online" (separate from legacyId)', () => {
    const entity = mapObservationRow(observations[0]);
    expect(entity.metadata.subsystem).toBe('online');
    // The subsystem discriminator MUST NOT be nested inside legacyId.
    expect(entity.legacyId).not.toHaveProperty('subsystem');
  });

  test('Test E: row.modifiedFiles === null → metadata.modifiedFiles is []', () => {
    // observations[0] has modifiedFiles: null per fixture
    const row = observations[0];
    expect(row.modifiedFiles).toBeNull();
    const entity = mapObservationRow(row);
    expect(entity.metadata.modifiedFiles).toEqual([]);
  });

  test('Test E (positive): non-null modifiedFiles propagates verbatim', () => {
    const row = observations[1]; // ['scripts/combined-status-line.js']
    expect(row.modifiedFiles).not.toBeNull();
    const entity = mapObservationRow(row);
    expect(entity.metadata.modifiedFiles).toEqual(row.modifiedFiles);
  });

  test('Test F: row.llm === null → metadata.llm key absent', () => {
    const row = observations[0];
    expect(row.llm).toBeNull();
    const entity = mapObservationRow(row);
    expect('llm' in entity.metadata).toBe(false);
  });

  test('Test F (positive): non-null llm appears in metadata', () => {
    const row = observations[1]; // 'groq:llama-3.3-70b-versatile'
    const entity = mapObservationRow(row);
    expect(entity.metadata.llm).toBe(row.llm);
  });
});

describe('mapDigestRow', () => {
  test('Test G: returns Entity with entityType + ontologyClass = "Digest", populated observationIds, top-level legacyId, metadata.subsystem', () => {
    const row = digests[0];
    const entity = mapDigestRow(row);
    expect(entity.entityType).toBe('Digest');
    expect(entity.ontologyClass).toBe('Digest');
    expect(entity.metadata.observationIds).toEqual(row.observationIds);
    expect(Array.isArray(entity.metadata.observationIds)).toBe(true);
    expect((entity.metadata.observationIds as string[]).length).toBeGreaterThan(0);
    // Top-level legacyId per CF-D37.
    expect(entity.legacyId?.system).toBe('A');
    expect(entity.legacyId?.id).toBe(row.id);
    // metadata.subsystem separate from legacyId.
    expect(entity.metadata.subsystem).toBe('online');
  });

  test('Digest name derives from row.theme (Test I)', () => {
    const row = digests[0];
    const entity = mapDigestRow(row);
    expect(entity.name).toBe(row.theme);
  });
});

describe('mapInsightRow', () => {
  test('Test H: returns Entity with entityType + ontologyClass = "Insight", populated digestIds, top-level legacyId, metadata.subsystem', () => {
    const row = insights[0];
    const entity = mapInsightRow(row);
    expect(entity.entityType).toBe('Insight');
    expect(entity.ontologyClass).toBe('Insight');
    expect(entity.metadata.digestIds).toEqual(row.digestIds);
    expect(Array.isArray(entity.metadata.digestIds)).toBe(true);
    expect((entity.metadata.digestIds as string[]).length).toBeGreaterThan(0);
    // Top-level legacyId per CF-D37.
    expect(entity.legacyId?.system).toBe('A');
    expect(entity.legacyId?.id).toBe(row.id);
    expect(entity.metadata.subsystem).toBe('online');
    // metadata.confidence carried forward (per <action> spec)
    expect(entity.metadata.confidence).toBe(row.confidence);
  });

  test('Insight name derives from row.topic (Test I)', () => {
    const row = insights[0];
    const entity = mapInsightRow(row);
    expect(entity.name).toBe(row.topic);
  });
});

describe('deriveName behavior (Test I)', () => {
  test('Observation name = first non-empty line of summary, sliced ≤120 chars', () => {
    const row = observations[0];
    const entity = mapObservationRow(row);
    // First line is "Intent: Trace why the status-line health indicator stayed red despite a healthy coordinator."
    const expectedFirstLine = row.summary.split('\n').find((l) => l.trim().length > 0) ?? '';
    expect(entity.name).toBe(expectedFirstLine.trim().slice(0, 120));
    expect(entity.name.length).toBeLessThanOrEqual(120);
  });

  test('Observation with empty summary → name === "(empty)"', () => {
    const row = observations[3]; // summary: ''
    expect(row.summary).toBe('');
    const entity = mapObservationRow(row);
    expect(entity.name).toBe('(empty)');
  });
});

describe('Test J: purity', () => {
  test('mapObservationRow called twice with same input returns equal-by-value entities', () => {
    const row = observations[0];
    const a = mapObservationRow(row);
    const b = mapObservationRow(row);
    expect(a).toEqual(b);
    // Ensure mappers don't share state (different metadata objects).
    expect(a).not.toBe(b);
  });

  test('mapDigestRow called twice with same input returns equal-by-value entities', () => {
    const row = digests[0];
    const a = mapDigestRow(row);
    const b = mapDigestRow(row);
    expect(a).toEqual(b);
  });

  test('mapInsightRow called twice with same input returns equal-by-value entities', () => {
    const row = insights[0];
    const a = mapInsightRow(row);
    const b = mapInsightRow(row);
    expect(a).toEqual(b);
  });
});

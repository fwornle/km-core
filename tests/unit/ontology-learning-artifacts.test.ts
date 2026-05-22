// Phase 41 Plan 01 Task 2 — LearningArtifact ontology auto-discovery + extends-chain tests.
//
// Verifies that the live km-core/ontology/ directory (created in Plan 01 Task 1)
// is auto-discovered by OntologyRegistry (Phase 38 ONTO-01) AND that the
// Observation/Digest/Insight lowers resolve their extends chain to the
// LearningArtifact upper (Phase 38 ONTO-02 property merging).
//
// Test mapping:
//   Test A — registry constructs against live ontology/ dir without throwing
//   Test B — isValidClass('LearningArtifact')
//   Test C — isValidClass for Observation/Digest/Insight
//   Test D — parentChainOf('Observation') includes LearningArtifact ResolvedClass
//   Test E — Digest.relationships.aggregates includes 'Observation'
//   Test F — Insight.relationships.aggregates includes 'Digest'
//   Test G — Observation.properties merges upper (createdAt) + lower (summary)
//
// Phase 38 ONTO-02 contract being verified:
//   The registry's registerClasses() shallow-merges parent + child relationships
//   AND properties when a class declares per-class `extends`. Observation extends
//   LearningArtifact → Observation's resolved properties = LearningArtifact.properties
//   ∪ Observation.properties (child wins on key conflict).
//
// no-console-log: this test file uses neither console.* nor process.stderr.write.

import { describe, test, expect } from 'vitest';
import * as path from 'node:path';
import { OntologyRegistry } from '../../src/index.js';

// Live ontology dir at the package root (NOT the fixtures dir under tests/).
// __dirname equivalent under ESM: import.meta.dirname is Node 22+ per package.json
// engines ">=22"; matches the existing ontology-registry.test.ts FIXTURE_DIR
// resolution pattern at line 46.
const ONTOLOGY_DIR = path.resolve(import.meta.dirname, '..', '..', 'ontology');

describe('OntologyRegistry — LearningArtifact axis (Phase 41 Plan 01)', () => {
  // Single shared registry against the live ontology dir — sync load is cheap
  // and the registry is read-only after construction.
  const registry = new OntologyRegistry({ ontologyDir: ONTOLOGY_DIR });

  test('A: constructs against live ontology/ without throwing and is non-empty', () => {
    // If the constructor reached here, it did not throw. Sanity-check non-empty
    // catalog via the public getAllClassNames() accessor.
    const names = registry.getAllClassNames();
    expect(names.length).toBeGreaterThan(0);
  });

  test('B: isValidClass(LearningArtifact) returns true', () => {
    expect(registry.isValidClass('LearningArtifact')).toBe(true);
  });

  test('C: Observation / Digest / Insight are all valid classes', () => {
    expect(registry.isValidClass('Observation')).toBe(true);
    expect(registry.isValidClass('Digest')).toBe(true);
    expect(registry.isValidClass('Insight')).toBe(true);
  });

  test('D: parentChainOf(Observation) includes LearningArtifact ResolvedClass', () => {
    const chain = registry.parentChainOf('Observation');
    // parentChainOf returns ResolvedClass[] (objects), NOT string[].
    // Must match by `.name`, NOT `.includes('LearningArtifact')` — this is the
    // canonical correction per 41-01-PLAN Task 2 action note.
    expect(chain.some((rc) => rc.name === 'LearningArtifact')).toBe(true);
  });

  test('E: Digest.relationships.aggregates includes Observation', () => {
    const digest = registry.getClass('Digest');
    expect(digest).toBeDefined();
    expect(digest!.relationships).toBeDefined();
    expect(digest!.relationships.aggregates).toBeDefined();
    expect(digest!.relationships.aggregates).toContain('Observation');
  });

  test('F: Insight.relationships.aggregates includes Digest', () => {
    const insight = registry.getClass('Insight');
    expect(insight).toBeDefined();
    expect(insight!.relationships).toBeDefined();
    expect(insight!.relationships.aggregates).toBeDefined();
    expect(insight!.relationships.aggregates).toContain('Digest');
  });

  test('G: Observation.properties merges upper (createdAt) + lower (summary) per ONTO-02', () => {
    const observation = registry.getClass('Observation');
    expect(observation).toBeDefined();
    expect(observation!.properties).toBeDefined();
    // createdAt is declared on LearningArtifact (upper) and inherits via extends.
    expect(observation!.properties).toHaveProperty('createdAt');
    // summary is declared on Observation (lower) directly.
    expect(observation!.properties).toHaveProperty('summary');
  });
});

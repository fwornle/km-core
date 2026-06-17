// Phase 60 Plan 07 Task 1 — Data-shape test for coding-ontology.json (L1) and
// coding.lower.json (L2) carrying explicit `level` and `parent` fields at the
// CLASS LEVEL (not nested under properties).
//
// This is a pure data-shape contract test. It reads the two JSON files
// directly off disk (under .data/ontologies/) and asserts the 6 behaviors
// locked by Task 1 <behavior>:
//
//   Test 1: `coding-ontology.json` Component class has top-level `level: 1`
//   Test 2: SubComponent has top-level `level: 1`
//           (per Phase 60 D-17 + OntologyFilter.tsx:466-478 — Component,
//           SubComponent, Detail are ALL L1 anchors whose L2 children render
//           under them; the narrative-level documentation in `description`
//           strings says "L2"/"L4 leaf" but the OntologyFilter group logic
//           treats them as L1 grouping headers).
//   Test 3: Detail has top-level `level: 1`
//   Test 4: Every class in `coding.lower.json` has top-level `level: 2` AND
//           a `parent` field matching its `extends` value (10 classes).
//   Test 5: BC — no class in coding-ontology.json has its `description`,
//           `relationships`, or `properties` fields removed by the additive
//           change (sampled on Component, SubComponent, Detail since those
//           are the only L1 carriers in scope; full BC of other classes is
//           guarded by Phase 38 registry tests + Phase 57 integration tests).
//   Test 6: `coding.display.json` is not touched by this task (no file mtime
//           assertion; we check the keyed test fixture below to confirm the
//           overlay file has not been overwritten by data shape).
//
// no-console-log: pure assertion file; no diagnostics emitted.

import { describe, test, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Walk up from this test file's directory to find <repo>/.data/ontologies/.
// Robust against future workspace re-nesting.
function resolveRepoOntologyDir(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, '.data', 'ontologies');
    if (fs.existsSync(path.join(candidate, 'coding.lower.json'))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `coding.lower.json not found by walking up from ${import.meta.dirname}; ` +
      `expected to find <repo>/.data/ontologies/coding.lower.json.`,
  );
}

const ONTOLOGY_DIR = resolveRepoOntologyDir();

interface ClassDef {
  level?: number;
  parent?: string;
  extends?: string;
  description?: string;
  relationships?: Record<string, unknown>;
  properties?: Record<string, unknown>;
}

interface OntologyJson {
  meta: { name: string; version?: string; description?: string; extends?: string };
  classes: Record<string, ClassDef>;
}

function readOntology(file: string): OntologyJson {
  const raw = fs.readFileSync(path.join(ONTOLOGY_DIR, file), 'utf8');
  return JSON.parse(raw) as OntologyJson;
}

const L2_CLASS_NAMES = [
  'LiveLoggingSystem',
  'ConstraintMonitor',
  'OnlineObservation',
  'OnlineDigest',
  'OnlineInsight',
  'KnowledgeManagement',
  'BatchSemanticAnalysis',
  'RapidLlmProxy',
  'DockerizedServices',
  'EtmDaemon',
] as const;

describe('Phase 60.07 Task 1 — L1 + L2 level/parent data shape', () => {
  describe('coding-ontology.json L1 carriers', () => {
    test('Test 1: Component carries top-level level: 1', () => {
      const ont = readOntology('coding-ontology.json');
      const cls = ont.classes.Component;
      expect(cls, 'Component class must exist in coding-ontology.json').toBeDefined();
      expect(cls.level).toBe(1);
    });

    test('Test 2: SubComponent carries top-level level: 1', () => {
      const ont = readOntology('coding-ontology.json');
      const cls = ont.classes.SubComponent;
      expect(cls, 'SubComponent class must exist in coding-ontology.json').toBeDefined();
      expect(cls.level).toBe(1);
    });

    test('Test 3: Detail carries top-level level: 1', () => {
      const ont = readOntology('coding-ontology.json');
      const cls = ont.classes.Detail;
      expect(cls, 'Detail class must exist in coding-ontology.json').toBeDefined();
      expect(cls.level).toBe(1);
    });

    test('Test 5: BC — Component/SubComponent/Detail still carry description and relationships', () => {
      const ont = readOntology('coding-ontology.json');
      for (const name of ['Component', 'SubComponent', 'Detail']) {
        const cls = ont.classes[name];
        expect(cls, `${name} must still be defined`).toBeDefined();
        expect(
          typeof cls.description,
          `${name}.description must be preserved as string`,
        ).toBe('string');
        expect(
          cls.relationships,
          `${name}.relationships must be preserved`,
        ).toBeDefined();
      }
    });
  });

  describe('coding.lower.json L2 classes', () => {
    test('Test 4: every L2 class carries level: 2 AND parent === extends', () => {
      const ont = readOntology('coding.lower.json');
      const names = Object.keys(ont.classes);
      // Exactly the 10 L2 classes Phase 57 ships.
      expect(names.sort()).toEqual([...L2_CLASS_NAMES].sort());

      for (const name of L2_CLASS_NAMES) {
        const cls = ont.classes[name];
        expect(cls, `${name} must exist in coding.lower.json`).toBeDefined();
        expect(cls.level, `${name}.level must equal 2`).toBe(2);
        expect(
          typeof cls.parent,
          `${name}.parent must be a string`,
        ).toBe('string');
        expect(
          cls.parent,
          `${name}.parent must equal ${name}.extends (${cls.extends})`,
        ).toBe(cls.extends);
      }
    });

    test('Test 4b: parent values cover Component, SubComponent, Detail (3 distinct L1)', () => {
      const ont = readOntology('coding.lower.json');
      const parents = new Set<string>();
      for (const cls of Object.values(ont.classes)) {
        if (typeof cls.parent === 'string') parents.add(cls.parent);
      }
      expect(parents).toEqual(new Set(['Component', 'SubComponent', 'Detail']));
    });
  });

  describe('coding.display.json (overlay file not touched)', () => {
    test('Test 6: coding.display.json still exists with its overlay shape (or is absent — both are acceptable)', () => {
      const overlayPath = path.join(ONTOLOGY_DIR, 'coding.display.json');
      if (!fs.existsSync(overlayPath)) {
        // Not all repos carry a display overlay; absence is acceptable.
        return;
      }
      // If it exists, it MUST be parseable JSON and MUST NOT carry the
      // ontology-file shape (meta + classes) — that would indicate this task
      // wrote to the wrong file.
      const raw = fs.readFileSync(overlayPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      expect(typeof parsed).toBe('object');
      expect(parsed).not.toBeNull();
      const obj = parsed as Record<string, unknown>;
      expect(
        'meta' in obj && 'classes' in obj,
        'coding.display.json must NOT carry the ontology-file (meta+classes) shape',
      ).toBe(false);
    });
  });
});

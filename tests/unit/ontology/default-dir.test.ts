// Pins the defaultOntologyDir contract:
//   1. Returns the live bundled ontology directory at the package root.
//   2. The directory contains the LearningArtifact upper + lowers JSONs
//      (so a GraphKMStore constructed with it can resolve the
//      LearningArtifact subclass set for resolveEntities default-class
//      expansion — Phase 41 INT-01 + PIPE-02).
//   3. KM_ONTOLOGY_DIR env override is honored.
//   4. resolveEntities throws a helpful message naming the helper when
//      ontologyDir is unset and classes is omitted (the regression that
//      surfaced this helper in the first place).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  defaultOntologyDir,
  GraphKMStore,
  resolveEntities,
} from '../../../src/index.js';

describe('defaultOntologyDir', () => {
  const origEnv = process.env.KM_ONTOLOGY_DIR;

  beforeEach(() => {
    delete process.env.KM_ONTOLOGY_DIR;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env.KM_ONTOLOGY_DIR;
    else process.env.KM_ONTOLOGY_DIR = origEnv;
  });

  it('A: returns the bundled ontology directory at the km-core package root', () => {
    const dir = defaultOntologyDir();
    expect(path.isAbsolute(dir)).toBe(true);
    expect(existsSync(dir)).toBe(true);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(path.basename(dir)).toBe('ontology');
  });

  it('B: bundled ontology dir contains the LearningArtifact upper + lower JSONs', () => {
    const dir = defaultOntologyDir();
    expect(existsSync(path.join(dir, 'upper.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'learning-artifacts.json'))).toBe(true);
  });

  it('C: KM_ONTOLOGY_DIR env override is honored', () => {
    process.env.KM_ONTOLOGY_DIR = '/custom/ontology/path';
    expect(defaultOntologyDir()).toBe('/custom/ontology/path');
  });

  it('D: resolveEntities error message names defaultOntologyDir as the recommended fix', async () => {
    // Construct a store WITHOUT ontologyDir (simulates the Phase 41-07 CLI gap).
    const tmpdir = path.join(
      '/tmp',
      'km-core-default-dir-test-' + Date.now(),
    );
    const store = new GraphKMStore({
      dbPath: path.join(tmpdir, 'leveldb'),
      exportDir: path.join(tmpdir, 'exports'),
    });
    await store.open();
    try {
      await expect(
        resolveEntities(store, {
          llmMatcher: {
            match: async () => ({ matched: false, confidence: 0 }),
          },
          provenance: {
            provider: 'test',
            model: 'test',
            runId: 'test-run',
            timestamp: new Date().toISOString(),
          },
        }),
      ).rejects.toThrow(/defaultOntologyDir/);
    } finally {
      await store.close();
    }
  });
});

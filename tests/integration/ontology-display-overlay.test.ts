// Phase 45 Plan 04 Task 1 — ontology handler ?withDisplay=true extension tests.
//
// 5 behavior tests per 45-04-PLAN.md Task 1 <behavior>:
//   Handler Test 1 (BC regression — CRITICAL): GET /ontology/classes (no
//     param) returns {success:true, data: string[]} byte-identical to
//     pre-Phase-45. T-45-04-03 mitigation.
//   Handler Test 2: GET /ontology/classes?withDisplay=true returns array of
//     {name, level?, parent?, display?}; seeded class carries seeded color.
//   Handler Test 3: overlay file absent → enriched shape with display=undefined.
//   Handler Test 4: ?withDisplay=true&withDisplay=true treated as true.
//   Handler Test 5: ?withDisplay=foo treated as FALSE (BC shape).
//
// Mirrors the lifecycle from tests/integration/api-router.test.ts (Phase 44)
// — tmpdir + GraphKMStore + express app + supertest. Seeds a minimal ontology
// dir with upper.json + coding.json so the registry has classes to enumerate.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import express, { Router } from 'express';
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GraphKMStore } from '../../src/store/GraphKMStore.js';
import { OntologyRegistry } from '../../src/ontology/registry.js';
import { createKmCoreRouter } from '../../src/api/index.js';

// Minimal ontology fixtures — only enough classes to exercise the handler.
const UPPER_FIXTURE = {
  meta: { name: 'upper', version: '1.0.0', description: 't' },
  classes: {
    Component: { description: 'Code component', relationships: {}, properties: {} },
    Detail: { description: 'Detail level', relationships: {}, properties: {} },
  },
};

const CODING_FIXTURE = {
  meta: { name: 'coding', version: '1.0.0', description: 't' },
  classes: {
    Observation: { description: 'Obs', relationships: {}, properties: {} },
    Digest: { description: 'Digest', relationships: {}, properties: {} },
    Insight: { description: 'Insight', relationships: {}, properties: {} },
  },
};

const DISPLAY_FIXTURE = {
  Observation: { color: '#3b82f6', icon: 'Activity', shape: 'circle' },
  Digest: { color: '#10b981', icon: 'FileText', shape: 'circle' },
  Insight: { color: '#f59e0b', icon: 'Lightbulb', shape: 'circle' },
  Component: { color: '#8b5cf6', icon: 'Package', shape: 'square' },
  Detail: { color: '#6b7280', icon: 'Layers', shape: 'circle' },
};

interface TestEnv {
  tmpdir: string;
  ontologyDir: string;
  store: GraphKMStore;
  app: express.Express;
}

async function buildEnv(opts: { withDisplayFile: boolean }): Promise<TestEnv> {
  const tmpdir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'km-core-ontology-display-'),
  );
  const ontologyDir = path.join(tmpdir, 'ontologies');
  fs.mkdirSync(ontologyDir, { recursive: true });
  fs.writeFileSync(
    path.join(ontologyDir, 'upper.json'),
    JSON.stringify(UPPER_FIXTURE),
    'utf8',
  );
  fs.writeFileSync(
    path.join(ontologyDir, 'coding.json'),
    JSON.stringify(CODING_FIXTURE),
    'utf8',
  );
  if (opts.withDisplayFile) {
    fs.writeFileSync(
      path.join(ontologyDir, 'coding.display.json'),
      JSON.stringify(DISPLAY_FIXTURE, null, 2),
      'utf8',
    );
  }

  const store = new GraphKMStore({
    dbPath: path.join(tmpdir, 'leveldb'),
    exportDir: path.join(tmpdir, 'exports'),
    debounceMs: 0,
  });
  await store.open();

  const registry = new OntologyRegistry({ ontologyDir });

  const app = express();
  app.use(express.json());
  const kmRouter = Router();
  createKmCoreRouter(store, kmRouter, {
    snapshotDir: path.join(tmpdir, 'exports'),
    ontologyRegistry: registry,
    ontologyDir,
    displayOverlaySystem: 'coding',
  });
  app.use('/api/v1', kmRouter);

  return { tmpdir, ontologyDir, store, app };
}

async function teardown(env: TestEnv): Promise<void> {
  await env.store.close();
  fs.rmSync(env.tmpdir, { recursive: true, force: true });
}

describe('ontology /classes ?withDisplay=true (Plan 45-04 Task 1)', () => {
  let env: TestEnv;

  describe('with display overlay file present', () => {
    beforeEach(async () => {
      env = await buildEnv({ withDisplayFile: true });
    });
    afterEach(async () => {
      await teardown(env);
    });

    test('Handler Test 1: GET /ontology/classes (no param) returns string[] (BC — T-45-04-03)', async () => {
      const res = await request(env.app).get('/api/v1/ontology/classes');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      // T-45-04-03 byte-identical assertion — every element is a STRING.
      for (const d of res.body.data) {
        expect(typeof d).toBe('string');
      }
      // The fixture registered 5 classes total (2 upper + 3 coding).
      expect(res.body.data).toContain('Observation');
      expect(res.body.data).toContain('Component');
    });

    test('Handler Test 2: ?withDisplay=true returns enriched shape; Observation has seeded color', async () => {
      const res = await request(env.app).get(
        '/api/v1/ontology/classes?withDisplay=true',
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      // Every entry is an object with at least a `name` field.
      for (const d of res.body.data) {
        expect(typeof d).toBe('object');
        expect(typeof d.name).toBe('string');
      }
      const observation = res.body.data.find(
        (c: { name: string }) => c.name === 'Observation',
      );
      expect(observation).toBeDefined();
      expect(observation.display).toBeDefined();
      expect(observation.display.color).toBe('#3b82f6');
      expect(observation.display.icon).toBe('Activity');
      expect(observation.display.shape).toBe('circle');

      // Component carries the seeded square shape.
      const component = res.body.data.find(
        (c: { name: string }) => c.name === 'Component',
      );
      expect(component).toBeDefined();
      expect(component.display?.shape).toBe('square');
    });

    test('Handler Test 4: ?withDisplay=true&withDisplay=true (duplicate) treated as true', async () => {
      const res = await request(env.app).get(
        '/api/v1/ontology/classes?withDisplay=true&withDisplay=true',
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      // Enriched shape — every element is an object, not a string.
      for (const d of res.body.data) {
        expect(typeof d).toBe('object');
        expect(typeof d.name).toBe('string');
      }
    });

    test('Handler Test 5: ?withDisplay=foo (non-true value) returns BC string-array', async () => {
      const res = await request(env.app).get(
        '/api/v1/ontology/classes?withDisplay=foo',
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      // Each element is a string — BC path.
      for (const d of res.body.data) {
        expect(typeof d).toBe('string');
      }
    });

    test('Handler Test 5b: ?withDisplay=1 also returns BC shape (strict-equal "true")', async () => {
      const res = await request(env.app).get(
        '/api/v1/ontology/classes?withDisplay=1',
      );
      expect(res.status).toBe(200);
      for (const d of res.body.data) {
        expect(typeof d).toBe('string');
      }
    });
  });

  describe('without display overlay file', () => {
    beforeEach(async () => {
      env = await buildEnv({ withDisplayFile: false });
    });
    afterEach(async () => {
      await teardown(env);
    });

    test('Handler Test 3: ?withDisplay=true with absent overlay → enriched shape, display is undefined (not null/empty)', async () => {
      const res = await request(env.app).get(
        '/api/v1/ontology/classes?withDisplay=true',
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      // Shape is still enriched (objects, not strings).
      for (const d of res.body.data) {
        expect(typeof d).toBe('object');
        expect(typeof d.name).toBe('string');
        // Per plan: display should be UNDEFINED (the JSON serializer
        // omits undefined fields), NOT null and NOT {} — to keep the
        // serialized response consistent with "no preference authored".
        expect(d.display).toBeUndefined();
      }
    });

    test('Handler Test 1b: BC path still works without overlay file', async () => {
      const res = await request(env.app).get('/api/v1/ontology/classes');
      expect(res.status).toBe(200);
      for (const d of res.body.data) {
        expect(typeof d).toBe('string');
      }
    });
  });
});

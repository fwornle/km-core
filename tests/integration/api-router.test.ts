// Phase 44 Wave 0 RED stub: createKmCoreRouter integration test.
//
// CONTRACT WITH DOWNSTREAM PLANS:
//   This test imports from '../../src/api/index.js' which does NOT YET exist.
//   The module-not-found error against that path IS the expected RED state.
//   Plan 44-06 (router factory) creates src/api/index.ts; this test goes
//   GREEN once the canonical 15-endpoint surface is mounted.
//
// Why supertest + a real express app:
//   km-core ships as framework-agnostic (R-2: createKmCoreRouter(store, router, opts)
//   accepts a RouterLike object the consumer constructs). The TEST is itself a
//   consumer — it wires a real express Router instance and mounts at /api/v1.
//   This proves the factory works end-to-end the way A/B/C will use it.
//
// Lifecycle pattern mirrored from tests/integration/round-trip.test.ts:60-77:
//   tmpdir + GraphKMStore({ debounceMs: 0 }) + open()/close() + recursive rm.
//
// NOTE on the 15-endpoint smoke (Test 5): we drive each canonical path with the
// HTTP verb that should be registered per 44-RESEARCH.md §Example 2. A 404 from
// supertest means the route was never registered; ANY other status (200/201/400/500)
// means the handler is wired (success or controlled error — either proves routing).
// During RED phase the import fails before app is constructed, so all 6 tests die at
// import time — that is the contract.
//
// no-console-log: any diagnostics use process.stderr.write per CLAUDE.md / km-core
// CLAUDE.md no-console-log discipline.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import express, { Router } from 'express';
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GraphKMStore } from '../../src/store/GraphKMStore.js';
// RED IMPORT — Plan 44-06 deliverable. Do NOT collapse this import to a try/catch
// or `await import` guard; the module-not-found error against this exact path is
// the artifact downstream plans verify against.
import { createKmCoreRouter } from '../../src/api/index.js';

// Canonical surface per 44-RESEARCH.md §Example 2 (Phase 44 C-1 = OKM CRUD/query/
// ontology core + clusters + snapshots). 15 endpoints total. Smoke = registered != 404.
const CANONICAL_ENDPOINTS: Array<{ method: 'get' | 'post' | 'put' | 'delete'; path: string }> = [
  { method: 'get', path: '/api/v1/entities' },
  { method: 'post', path: '/api/v1/entities' },
  { method: 'get', path: '/api/v1/entities/nonexistent-id' },
  { method: 'put', path: '/api/v1/entities/nonexistent-id' },
  { method: 'delete', path: '/api/v1/entities/nonexistent-id' },
  { method: 'get', path: '/api/v1/relations' },
  { method: 'post', path: '/api/v1/relations' },
  { method: 'post', path: '/api/v1/query' },
  { method: 'get', path: '/api/v1/export' },
  { method: 'get', path: '/api/v1/stats' },
  { method: 'get', path: '/api/v1/ontology/classes' },
  { method: 'get', path: '/api/v1/ontology/entity-types' },
  { method: 'get', path: '/api/v1/graph/connectivity' },
  { method: 'get', path: '/api/v1/graph/orphans' },
  { method: 'get', path: '/api/v1/snapshots' },
];

describe('createKmCoreRouter — canonical /api/v1 surface', () => {
  let tmpdir: string;
  let store: GraphKMStore;
  let app: express.Express;

  beforeEach(async () => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-api-router-'));
    store = new GraphKMStore({
      dbPath: path.join(tmpdir, 'leveldb'),
      exportDir: path.join(tmpdir, 'exports'),
      debounceMs: 0,
    });
    // CRITICAL: open() must be awaited before any putEntity / iterate call,
    // otherwise the underlying LevelDB throws on first write (km-core gotcha).
    await store.open();

    app = express();
    app.use(express.json());
    const kmRouter = Router();
    // Factory call — RED until Plan 44-06 lands src/api/index.ts.
    createKmCoreRouter(store, kmRouter, {
      snapshotDir: path.join(tmpdir, 'exports'),
    });
    app.use('/api/v1', kmRouter);
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  test('GET /api/v1/entities on empty store returns 200 + envelope { success:true, data:[] }', async () => {
    const res = await request(app).get('/api/v1/entities');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: [] });
  });

  test('POST /api/v1/entities + GET round-trip persists created entity', async () => {
    const body = {
      name: 'TestComponent',
      entityType: 'Component',
      ontologyClass: 'Component',
      layer: 'evidence',
      description: 'Phase 44 RED stub fixture',
      metadata: {},
    };
    const postRes = await request(app).post('/api/v1/entities').send(body);
    expect(postRes.status).toBe(201);
    expect(postRes.body.success).toBe(true);
    expect(postRes.body.data).toMatchObject({
      name: 'TestComponent',
      entityType: 'Component',
    });

    const getRes = await request(app).get('/api/v1/entities');
    expect(getRes.status).toBe(200);
    expect(Array.isArray(getRes.body.data)).toBe(true);
    expect(getRes.body.data.length).toBeGreaterThanOrEqual(1);
  });

  test('GET /api/v1/entities?ontologyClass=Component filters via store.findByOntologyClass (Pitfall 3 two-field OR)', async () => {
    // Seed two entities: one Component, one Pattern.
    await request(app).post('/api/v1/entities').send({
      name: 'Comp1',
      entityType: 'Component',
      ontologyClass: 'Component',
      layer: 'evidence',
      description: 'a',
      metadata: {},
    });
    await request(app).post('/api/v1/entities').send({
      name: 'Pat1',
      entityType: 'Pattern',
      ontologyClass: 'Pattern',
      layer: 'pattern',
      description: 'b',
      metadata: {},
    });

    const res = await request(app).get('/api/v1/entities?ontologyClass=Component');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Filter must return only Component-classed entities (Pitfall 3: backing
    // store checks BOTH entityType AND ontologyClass via OR).
    for (const e of res.body.data) {
      const matchesEither = e.entityType === 'Component' || e.ontologyClass === 'Component';
      expect(matchesEither).toBe(true);
    }
  });

  test('GET /api/v1/stats returns 200 + envelope with entityCount + relationCount', async () => {
    const res = await request(app).get('/api/v1/stats');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(
      expect.objectContaining({
        entityCount: expect.any(Number),
        relationCount: expect.any(Number),
      }),
    );
  });

  test('All 15 canonical endpoints are registered (smoke: any status != 404)', async () => {
    // Probe each canonical path with its expected verb. 404 = route never registered
    // (failure); 200/201/400/500 = handler wired (registration success).
    const failures: string[] = [];
    for (const ep of CANONICAL_ENDPOINTS) {
      const res = await (request(app) as any)[ep.method](ep.path).send({});
      if (res.status === 404) {
        failures.push(`${ep.method.toUpperCase()} ${ep.path} returned 404 (not registered)`);
      }
    }
    if (failures.length > 0) {
      process.stderr.write(`[api-router.test] unregistered endpoints:\n${failures.join('\n')}\n`);
    }
    expect(failures).toEqual([]);
  });

  test('createKmCoreRouter with { readOnly: true } rejects POST/PUT/DELETE', async () => {
    // Spin a SECOND app with readOnly:true to isolate from the beforeEach mount.
    const roApp = express();
    roApp.use(express.json());
    const roRouter = Router();
    createKmCoreRouter(store, roRouter, {
      snapshotDir: path.join(tmpdir, 'exports'),
      readOnly: true,
    });
    roApp.use('/api/v1', roRouter);

    // POST against a read-only mount must NOT succeed. Per task contract: either
    // 405 (Method Not Allowed) OR 404 (route not registered when readOnly).
    const postRes = await request(roApp).post('/api/v1/entities').send({
      name: 'X',
      entityType: 'Component',
      layer: 'evidence',
      description: '',
      metadata: {},
    });
    expect([404, 405]).toContain(postRes.status);

    // GET (idempotent read) MUST still work on a readOnly mount.
    const getRes = await request(roApp).get('/api/v1/entities');
    expect(getRes.status).toBe(200);
  });
});

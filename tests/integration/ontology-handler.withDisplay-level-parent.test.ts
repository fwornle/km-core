// Phase 60 Plan 07 Task 2 — ontology handler enriched-path synthesis tests.
//
// Behavior cases (9 tests) per 60-07-PLAN.md Task 2 <behavior>:
//
//   Test 1 (Path B synthesis): for the coding system, the enriched response
//     includes synthesized entries {name:"System", level:0} and
//     {name:"Project", level:0} even when the registry has no class
//     definition for them.
//   Test 2 (synthesis idempotency): if System or Project DOES exist as a
//     registered class, no duplicate is emitted — handler dedups by name.
//   Test 3 (parent fallback): for each L2 class without an explicit `parent`
//     field but with `extends: <X>`, handler emits `parent: <X>`.
//   Test 4 (explicit parent precedence): when a class has BOTH explicit
//     `parent: "A"` and `extends: "B"`, explicit `parent` wins.
//   Test 5 (level: 1 surfacing): a class with top-level `level: 1` carries
//     `level: 1` in the response.
//   Test 6 (level: 2 surfacing): a class with top-level `level: 2` AND a
//     `parent` field surfaces both.
//   Test 7 (display preserved): when an overlay entry exists for a class,
//     the `display` field still appears in the response (no Plan 45-04
//     regression).
//   Test 8 (BC string-array path): GET /ontology/classes WITHOUT
//     ?withDisplay=true returns {success:true, data:[strings]} — T-45-04-03
//     mitigation preserved.
//   Test 9 (non-coding system scope): enriched response for a non-coding
//     system does NOT get HIERARCHY_ROOTS synthesis. The handler only
//     synthesizes L0 anchors when `displayOverlaySystem === 'coding'`.
//
// Lifecycle pattern mirrors tests/integration/ontology-display-overlay.test.ts
// (Phase 45 Plan 04 fixture template): tmpdir + GraphKMStore + express app +
// supertest. Each test rebuilds an isolated fixture so synthesis behaviour is
// asserted against a known class set.
//
// no-console-log: pure assertion file; no diagnostics emitted.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import express, { Router } from 'express';
import request from 'supertest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GraphKMStore } from '../../src/store/GraphKMStore.js';
import { OntologyRegistry } from '../../src/ontology/registry.js';
import { createKmCoreRouter } from '../../src/api/index.js';

// Minimal upper.json carrying System + Project so we can independently
// register them in Test 2 (idempotency).
const UPPER_FIXTURE_BASE = {
  meta: { name: 'upper', version: '1.0.0', description: 't' },
  classes: {
    File: { description: 'File', relationships: {}, properties: {} },
    Component: { description: 'Component', relationships: {}, properties: {} },
    SubComponent: { description: 'SubComponent', relationships: {}, properties: {} },
    Detail: { description: 'Detail', relationships: {}, properties: {} },
  },
};

// Upper with System + Project pre-registered (for Test 2 idempotency).
const UPPER_FIXTURE_WITH_ROOTS = {
  meta: { name: 'upper', version: '1.0.0', description: 't' },
  classes: {
    File: { description: 'File', relationships: {}, properties: {} },
    Component: { description: 'Component', relationships: {}, properties: {} },
    SubComponent: { description: 'SubComponent', relationships: {}, properties: {} },
    Detail: { description: 'Detail', relationships: {}, properties: {} },
    System: { description: 'System', level: 0, relationships: {}, properties: {} },
    Project: { description: 'Project', level: 0, relationships: {}, properties: {} },
  },
};

// Coding lower with L1 + L2 fixtures mirroring the live data shape.
const CODING_FIXTURE_L1 = {
  meta: { name: 'coding', version: '1.0.0', description: 't' },
  classes: {
    Component: {
      description: 'L1 Component',
      level: 1,
      relationships: {},
      properties: {},
    },
    Detail: {
      description: 'L1 Detail',
      level: 1,
      relationships: {},
      properties: {},
    },
  },
};

// L2 lower: tests parent-derivation-from-extends + explicit-parent precedence.
const CODING_LOWER_FIXTURE = {
  meta: { name: 'coding.lower', version: '1.0.0', description: 't' },
  classes: {
    // L2 with explicit level + parent (matches live coding.lower.json shape)
    LiveLoggingSystem: {
      extends: 'Component',
      level: 2,
      parent: 'Component',
      description: 'L2 Live Logging',
      relationships: {},
    },
    // L2 with extends but NO explicit parent — exercises Test 3 fallback
    OnlineObservation: {
      extends: 'Detail',
      level: 2,
      description: 'L2 with extends only — parent fallback',
      relationships: {},
    },
    // L2 with extends="B" AND explicit parent="A" — exercises Test 4 precedence
    ExplicitOverride: {
      extends: 'Component',
      parent: 'Detail',
      level: 2,
      description: 'explicit parent wins',
      relationships: {},
    },
  },
};

const DISPLAY_FIXTURE = {
  LiveLoggingSystem: {
    color: '#3b82f6',
    icon: 'Activity',
    shape: 'square',
  },
  Component: { color: '#10b981', icon: 'Package', shape: 'square' },
};

interface TestEnv {
  tmpdir: string;
  ontologyDir: string;
  store: GraphKMStore;
  app: express.Express;
}

async function buildEnv(opts: {
  upper: 'base' | 'with-roots';
  withDisplayFile?: boolean;
  overlaySystem?: string; // default 'coding'
}): Promise<TestEnv> {
  const tmpdir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'km-core-60-07-handler-'),
  );
  const ontologyDir = path.join(tmpdir, 'ontologies');
  fs.mkdirSync(ontologyDir, { recursive: true });

  const upper = opts.upper === 'with-roots' ? UPPER_FIXTURE_WITH_ROOTS : UPPER_FIXTURE_BASE;
  fs.writeFileSync(
    path.join(ontologyDir, 'upper.json'),
    JSON.stringify(upper),
    'utf8',
  );
  fs.writeFileSync(
    path.join(ontologyDir, 'coding.json'),
    JSON.stringify(CODING_FIXTURE_L1),
    'utf8',
  );
  fs.writeFileSync(
    path.join(ontologyDir, 'coding.lower.json'),
    JSON.stringify(CODING_LOWER_FIXTURE),
    'utf8',
  );

  if (opts.withDisplayFile) {
    fs.writeFileSync(
      path.join(ontologyDir, 'coding.display.json'),
      JSON.stringify(DISPLAY_FIXTURE),
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
    displayOverlaySystem: opts.overlaySystem ?? 'coding',
  });
  app.use('/api/v1', kmRouter);

  return { tmpdir, ontologyDir, store, app };
}

async function teardown(env: TestEnv): Promise<void> {
  await env.store.close();
  fs.rmSync(env.tmpdir, { recursive: true, force: true });
}

interface EnrichedClass {
  name: string;
  level?: number;
  parent?: string;
  display?: { color?: string; icon?: string; shape?: string };
}

describe('ontology handler — Phase 60.07 Task 2 (level/parent/HIERARCHY_ROOTS)', () => {
  let env: TestEnv;

  describe('coding system (displayOverlaySystem = "coding")', () => {
    beforeEach(async () => {
      env = await buildEnv({ upper: 'base', withDisplayFile: true });
    });
    afterEach(async () => {
      await teardown(env);
    });

    test('Test 1: Path B synthesis — System + Project appear with level:0 even when not registered', async () => {
      const res = await request(env.app).get(
        '/api/v1/ontology/classes?withDisplay=true',
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const data: EnrichedClass[] = res.body.data;
      const system = data.find((e) => e.name === 'System');
      const project = data.find((e) => e.name === 'Project');
      expect(system, 'System L0 anchor must be synthesized').toBeDefined();
      expect(system!.level).toBe(0);
      expect(project, 'Project L0 anchor must be synthesized').toBeDefined();
      expect(project!.level).toBe(0);
    });

    test('Test 3: parent fallback — extends-only L2 class gets parent derived from extends', async () => {
      const res = await request(env.app).get(
        '/api/v1/ontology/classes?withDisplay=true',
      );
      const data: EnrichedClass[] = res.body.data;
      const oo = data.find((e) => e.name === 'OnlineObservation');
      expect(oo).toBeDefined();
      expect(oo!.parent, 'extends-only class parent must fall back to extends value').toBe(
        'Detail',
      );
    });

    test('Test 4: explicit parent precedence — explicit parent wins over extends', async () => {
      const res = await request(env.app).get(
        '/api/v1/ontology/classes?withDisplay=true',
      );
      const data: EnrichedClass[] = res.body.data;
      const eo = data.find((e) => e.name === 'ExplicitOverride');
      expect(eo).toBeDefined();
      // Class has extends:"Component" but explicit parent:"Detail" — explicit wins
      expect(eo!.parent).toBe('Detail');
    });

    test('Test 5: level:1 surfaces from class definition', async () => {
      const res = await request(env.app).get(
        '/api/v1/ontology/classes?withDisplay=true',
      );
      const data: EnrichedClass[] = res.body.data;
      const component = data.find((e) => e.name === 'Component');
      expect(component).toBeDefined();
      expect(component!.level).toBe(1);
    });

    test('Test 6: level:2 + parent surface on Phase-57-style L2 class', async () => {
      const res = await request(env.app).get(
        '/api/v1/ontology/classes?withDisplay=true',
      );
      const data: EnrichedClass[] = res.body.data;
      const lls = data.find((e) => e.name === 'LiveLoggingSystem');
      expect(lls).toBeDefined();
      expect(lls!.level).toBe(2);
      expect(lls!.parent).toBe('Component');
    });

    test('Test 7: display overlay still applies on enriched response', async () => {
      const res = await request(env.app).get(
        '/api/v1/ontology/classes?withDisplay=true',
      );
      const data: EnrichedClass[] = res.body.data;
      const lls = data.find((e) => e.name === 'LiveLoggingSystem');
      expect(lls).toBeDefined();
      expect(lls!.display).toBeDefined();
      expect(lls!.display!.color).toBe('#3b82f6');
      expect(lls!.display!.icon).toBe('Activity');
    });

    test('Test 8: BC string-array path preserved on /ontology/classes (no ?withDisplay)', async () => {
      const res = await request(env.app).get('/api/v1/ontology/classes');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      for (const d of res.body.data) {
        expect(typeof d).toBe('string');
      }
      // T-45-04-03 BC — must NOT contain synthesized System/Project here.
      expect(res.body.data).not.toContain('System');
      expect(res.body.data).not.toContain('Project');
    });
  });

  describe('idempotency when System/Project pre-registered (Test 2)', () => {
    beforeEach(async () => {
      env = await buildEnv({ upper: 'with-roots', withDisplayFile: false });
    });
    afterEach(async () => {
      await teardown(env);
    });

    test('Test 2: registered System/Project — handler dedups by name (single entry each)', async () => {
      const res = await request(env.app).get(
        '/api/v1/ontology/classes?withDisplay=true',
      );
      expect(res.status).toBe(200);
      const data: EnrichedClass[] = res.body.data;
      const systemEntries = data.filter((e) => e.name === 'System');
      const projectEntries = data.filter((e) => e.name === 'Project');
      expect(
        systemEntries.length,
        'System must appear exactly once (no synthesized duplicate)',
      ).toBe(1);
      expect(
        projectEntries.length,
        'Project must appear exactly once',
      ).toBe(1);
      // The registered class carries level:0 from fixture; handler MUST preserve.
      expect(systemEntries[0]!.level).toBe(0);
      expect(projectEntries[0]!.level).toBe(0);
    });
  });

  describe('non-coding system scope (Test 9)', () => {
    beforeEach(async () => {
      env = await buildEnv({
        upper: 'base',
        withDisplayFile: false,
        overlaySystem: 'okb', // not the coding system
      });
    });
    afterEach(async () => {
      await teardown(env);
    });

    test('Test 9: non-coding system — HIERARCHY_ROOTS NOT synthesized', async () => {
      const res = await request(env.app).get(
        '/api/v1/ontology/classes?withDisplay=true',
      );
      expect(res.status).toBe(200);
      const data: EnrichedClass[] = res.body.data;
      const system = data.find((e) => e.name === 'System');
      const project = data.find((e) => e.name === 'Project');
      // Neither was authored in this fixture; neither should be synthesized
      // because the overlay system is 'okb', not 'coding'. This keeps the
      // synthesis scoped to the configured coding system per the plan's
      // conservative default.
      expect(system, 'System must NOT be synthesized for non-coding system').toBeUndefined();
      expect(project, 'Project must NOT be synthesized for non-coding system').toBeUndefined();
    });
  });
});

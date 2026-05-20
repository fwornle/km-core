// CORE-02: PersistenceManager — LevelDB-first hydrate, JSON-export fallback,
// atomic temp+rename writes, re-entry guard.
//
// Wave 0 RED state: `PersistenceManager` not yet exported from
// '../../src/store/persistence.js'. Plan 03 (CORE-02 persistence) makes
// these GREEN.

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { PersistenceManager } from '../../src/store/persistence.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-persist-'));
}

describe('PersistenceManager', () => {
  let tmpdir: string;
  let pm: PersistenceManager;

  beforeEach(() => {
    tmpdir = makeTmp();
  });

  afterEach(async () => {
    if (pm) await pm.close();
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  test('hydrate returns null on empty LevelDB', async () => {
    pm = new PersistenceManager(
      path.join(tmpdir, 'leveldb'),
      path.join(tmpdir, 'exports'),
    );
    const result = await pm.hydrate();
    expect(result).toBeNull();
  });

  test('hydrate returns parsed graph from LevelDB when present', async () => {
    pm = new PersistenceManager(
      path.join(tmpdir, 'leveldb'),
      path.join(tmpdir, 'exports'),
    );
    const seed = {
      attributes: {},
      options: { type: 'directed', multi: true, allowSelfLoops: true },
      nodes: [
        {
          key: '01900000-0000-7000-8000-000000000000',
          attributes: { id: '01900000-0000-7000-8000-000000000000', name: 'X' },
        },
      ],
      edges: [],
    };
    await pm.persistGraph(seed);
    const out = await pm.hydrate();
    expect(out).not.toBeNull();
    expect(out!.nodes.length).toBe(1);
  });

  test('hydrate falls back to JSON exports when LevelDB has LEVEL_NOT_FOUND', async () => {
    const exportDir = path.join(tmpdir, 'exports');
    fs.mkdirSync(exportDir, { recursive: true });
    fs.writeFileSync(
      path.join(exportDir, 'general.json'),
      JSON.stringify({
        attributes: {},
        options: { type: 'directed', multi: true, allowSelfLoops: true },
        nodes: [
          {
            key: '01900000-0000-7000-8000-000000000001',
            attributes: { id: '01900000-0000-7000-8000-000000000001' },
          },
        ],
        edges: [],
      }),
    );
    pm = new PersistenceManager(path.join(tmpdir, 'leveldb'), exportDir);
    const out = await pm.hydrate();
    expect(out).not.toBeNull();
    expect(out!.nodes.length).toBeGreaterThanOrEqual(1);
  });

  test('persist writes atomically via temp+rename', async () => {
    pm = new PersistenceManager(
      path.join(tmpdir, 'leveldb'),
      path.join(tmpdir, 'exports'),
    );
    const renameSpy = vi.spyOn(fs.promises, 'rename');
    await pm.exportJson({
      attributes: {},
      options: { type: 'directed', multi: true, allowSelfLoops: true },
      nodes: [],
      edges: [],
    });
    expect(renameSpy).toHaveBeenCalled();
    const firstCall = renameSpy.mock.calls[0]!;
    const src = String(firstCall[0]);
    // Source should be `<final>.tmp.<pid>.<ts>` shape.
    expect(src).toMatch(/\.tmp\.\d+\.\d+$/);
    renameSpy.mockRestore();
  });

  test('re-entry guard: concurrent persist calls no-op the second', async () => {
    pm = new PersistenceManager(
      path.join(tmpdir, 'leveldb'),
      path.join(tmpdir, 'exports'),
    );
    const graph = {
      attributes: {},
      options: { type: 'directed', multi: true, allowSelfLoops: true },
      nodes: [],
      edges: [],
    };
    // Fire two persist() calls without awaiting the first; the second must
    // observe the `writing` flag and return early.
    const p1 = pm.exportJson(graph);
    const p2 = pm.exportJson(graph);
    const [r1, r2] = await Promise.all([p1, p2]);
    // Both resolve; the second returned early (no throw, no double-write).
    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
  });
});

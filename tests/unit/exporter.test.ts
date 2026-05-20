// CORE-02: Exporter — atomic temp+rename, 5s debounce coalescing,
// per-domain bucketing, re-entry guard.
//
// Wave 0 RED state: `Exporter` not yet exported from
// '../../src/store/exporter.js'. Plan 03 (CORE-02 exporter) makes
// these GREEN.

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { Exporter } from '../../src/store/exporter.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-exporter-'));
}

describe('Exporter', () => {
  let tmpdir: string;

  beforeEach(() => {
    tmpdir = makeTmp();
  });

  afterEach(() => {
    fs.rmSync(tmpdir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  test('exportJson buckets nodes by metadata.domain', async () => {
    const exporter = new Exporter({
      exportDir: tmpdir,
      domains: ['raas', 'kpifw', 'general'],
      debounceMs: 0,
    });
    const graph = {
      attributes: {},
      options: { type: 'directed', multi: true, allowSelfLoops: true },
      nodes: [
        {
          key: 'n1',
          attributes: { id: 'n1', metadata: { domain: 'raas' } },
        },
        {
          key: 'n2',
          attributes: { id: 'n2', metadata: { domain: 'kpifw' } },
        },
        {
          key: 'n3',
          attributes: { id: 'n3', metadata: { domain: 'general' } },
        },
        {
          key: 'n4',
          attributes: { id: 'n4', metadata: { domain: 'unknown' } },
        },
      ],
      edges: [],
    };
    await exporter.exportJson(graph);
    expect(fs.existsSync(path.join(tmpdir, 'raas.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpdir, 'kpifw.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpdir, 'general.json'))).toBe(true);
    // Unknown domain goes to general.json (sane default).
    const general = JSON.parse(
      fs.readFileSync(path.join(tmpdir, 'general.json'), 'utf-8'),
    );
    const ids = (general.nodes as Array<{ key: string }>).map((n) => n.key);
    expect(ids).toContain('n3');
    expect(ids).toContain('n4');
  });

  test('exportJson uses temp-file + rename for each domain', async () => {
    const exporter = new Exporter({
      exportDir: tmpdir,
      domains: ['general'],
      debounceMs: 0,
    });
    const renameSpy = vi.spyOn(fs.promises, 'rename');
    await exporter.exportJson({
      attributes: {},
      options: { type: 'directed', multi: true, allowSelfLoops: true },
      nodes: [],
      edges: [],
    });
    expect(renameSpy).toHaveBeenCalled();
    const firstCall = renameSpy.mock.calls[0]!;
    const src = String(firstCall[0]);
    const dst = String(firstCall[1]);
    expect(src).toMatch(/\.tmp\.\d+\.\d+$/);
    expect(dst).toMatch(/general\.json$/);
    renameSpy.mockRestore();
  });

  test('debounce coalesces 10 rapid mutations into a single export', async () => {
    vi.useFakeTimers();
    const exporter = new Exporter({
      exportDir: tmpdir,
      domains: ['general'],
      debounceMs: 5000,
    });
    const flushSpy = vi.spyOn(exporter, 'exportJson');
    const graph = {
      attributes: {},
      options: { type: 'directed', multi: true, allowSelfLoops: true },
      nodes: [],
      edges: [],
    };
    for (let i = 0; i < 10; i++) {
      exporter.scheduleExport(graph);
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(5000);
    expect(flushSpy).toHaveBeenCalledTimes(1);
  });

  test('overlapping exports no-op the second via writing guard', async () => {
    const exporter = new Exporter({
      exportDir: tmpdir,
      domains: ['general'],
      debounceMs: 0,
    });
    const graph = {
      attributes: {},
      options: { type: 'directed', multi: true, allowSelfLoops: true },
      nodes: [],
      edges: [],
    };
    // Fire concurrently — the second must observe the `writing` flag and
    // return early without throwing or double-writing.
    const p1 = exporter.exportJson(graph);
    const p2 = exporter.exportJson(graph);
    await Promise.all([p1, p2]);
    expect(fs.existsSync(path.join(tmpdir, 'general.json'))).toBe(true);
  });
});

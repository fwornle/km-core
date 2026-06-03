// Phase 44 Wave 0 RED stub: SnapshotManager git-tag-backed snapshot/restore.
//
// CONTRACT WITH DOWNSTREAM PLANS:
//   This test imports from '../../src/snapshots/SnapshotManager.js' which does
//   NOT YET exist. The module-not-found error against that path IS the expected
//   RED state. Plan 44-04 (SnapshotManager — see 44-RESEARCH.md §Pattern 4 +
//   44-PATTERNS.md §src/snapshots/SnapshotManager.ts) makes this GREEN.
//
// Fixture model:
//   beforeEach mkdtempSync — isolated tmpdir per test.
//   `git init` + `git config user.{email,name}` so commit/tag operations succeed
//   without inheriting host config (CI sometimes lacks it).
//   GraphKMStore with debounceMs:0 and exportDir under the tmpdir; .data/exports
//   is the directory git tracks (per S-1 whole-dir atomic snapshot semantics).
//
// What each test pins:
//   T1: createSnapshot('test-label') produces tag matching the canonical S-4
//       format `snapshot/test-label-<UTC-ts>` (regex: /^snapshot\/test-label-
//       \d{4}-\d{2}-\d{2}T.+$/) AND commit msg `chore(snapshot): test-label`.
//       Format pinned by S-4 (git tags as snapshot IDs).
//   T2: listSnapshots returns the created entry with id, label, timestamp,
//       commit_sha, domains_present fields (the SnapshotEntry shape from
//       44-RESEARCH.md Pattern 4 lines 352-360).
//   T3: Round-trip — putEntity → exportJson → createSnapshot('s1') → putEntity
//       (another) → restoreSnapshot('snapshot/s1-<ts>') → exports match the
//       snapshot state (deterministic key set after canonicalization).
//   T4: createSnapshot wraps git commit with OKB_SNAPSHOT=1 env-var (Pitfall 1).
//       Asserted via a stub pre-commit hook that records the env var to a sentinel
//       file; if the env var is missing, the hook would fail and the snapshot
//       would not be created.
//
// no-console-log: shell stderr via execSync is allowed; test-side uses
// process.stderr.write for diagnostics.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { GraphKMStore } from '../../src/store/GraphKMStore.js';
// RED IMPORT — Plan 44-04 deliverable.
import { SnapshotManager } from '../../src/snapshots/SnapshotManager.js';

function gitInit(dir: string): void {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "phase44-wave0@test.invalid"', { cwd: dir });
  execSync('git config user.name "phase44-wave0"', { cwd: dir });
  // Establish a baseline commit so subsequent commits aren't the root commit
  // (git tag against root commit works but the round-trip test relies on a
  // pre-existing HEAD).
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  execSync('git add .gitignore', { cwd: dir });
  execSync('git commit -q -m "chore: baseline" --allow-empty', {
    cwd: dir,
    env: { ...process.env, OKB_SNAPSHOT: '1' },
  });
}

describe('SnapshotManager — git-tag-backed snapshot/restore (S-1, S-2, S-4)', () => {
  let tmpdir: string;
  let store: GraphKMStore;
  let exportDir: string;

  beforeEach(async () => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-snapshot-'));
    gitInit(tmpdir);

    exportDir = path.join(tmpdir, '.data', 'exports');
    fs.mkdirSync(exportDir, { recursive: true });

    store = new GraphKMStore({
      dbPath: path.join(tmpdir, '.data', 'leveldb'),
      exportDir,
      debounceMs: 0,
    });
    await store.open();
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  test('createSnapshot produces a snapshot/<label>-<UTC-ts> tag and chore(snapshot) commit', async () => {
    const mgr = new SnapshotManager({ exportDir });

    // Seed a domain export so git has something to commit.
    await store.putEntity({
      id: 'entity/01TEST',
      name: 'SeedEntity',
      entityType: 'Component',
      layer: 'evidence',
      description: '',
      metadata: {},
      createdAt: '2026-06-03T12:00:00Z',
      updatedAt: '2026-06-03T12:00:00Z',
    } as Parameters<GraphKMStore['putEntity']>[0]);
    await store.exportJson();

    const entry = await mgr.createSnapshot('test-label');

    // S-4 ID format: snapshot/<label>-<ISO-like-ts>
    expect(entry.id).toMatch(/^snapshot\/test-label-\d{4}-\d{2}-\d{2}T.+$/);
    expect(entry.label).toBe('test-label');

    // Commit message contract (S-3 OKB-baseline bypass triggers on chore(snapshot)).
    const lastMsg = execSync('git log -1 --format=%s', { cwd: tmpdir, encoding: 'utf-8' }).trim();
    expect(lastMsg).toBe('chore(snapshot): test-label');

    // Tag must exist in git.
    const tags = execSync('git tag -l snapshot/*', { cwd: tmpdir, encoding: 'utf-8' }).trim();
    expect(tags).toContain(entry.id);
  });

  test('listSnapshots returns entries with id, label, timestamp, commit_sha, domains_present', async () => {
    const mgr = new SnapshotManager({ exportDir });

    await store.putEntity({
      id: 'entity/01LIST',
      name: 'L',
      entityType: 'Component',
      layer: 'evidence',
      description: '',
      metadata: {},
      createdAt: '2026-06-03T12:00:00Z',
      updatedAt: '2026-06-03T12:00:00Z',
    } as Parameters<GraphKMStore['putEntity']>[0]);
    await store.exportJson();

    const created = await mgr.createSnapshot('list-probe');
    const list = await mgr.listSnapshots();
    expect(Array.isArray(list)).toBe(true);
    const found = list.find((e) => e.id === created.id);
    expect(found).toBeDefined();
    expect(found).toEqual(
      expect.objectContaining({
        id: created.id,
        label: 'list-probe',
        timestamp: expect.any(String),
        commit_sha: expect.any(String),
        domains_present: expect.any(Array),
      }),
    );
  });

  test('round-trip: snapshot → mutate → restore restores the exports state', async () => {
    const mgr = new SnapshotManager({ exportDir });

    // Phase A: seed and snapshot.
    await store.putEntity({
      id: 'entity/01ROUND-A',
      name: 'EntityA',
      entityType: 'Component',
      layer: 'evidence',
      description: 'phase A',
      metadata: {},
      createdAt: '2026-06-03T12:00:00Z',
      updatedAt: '2026-06-03T12:00:00Z',
    } as Parameters<GraphKMStore['putEntity']>[0]);
    await store.exportJson();

    // Snapshot the current exports.
    const snap = await mgr.createSnapshot('s1');

    // Capture the byte-state of all .json files in exportDir at snapshot time.
    const snapshotState: Record<string, string> = {};
    for (const f of fs.readdirSync(exportDir)) {
      if (f.endsWith('.json')) {
        snapshotState[f] = fs.readFileSync(path.join(exportDir, f), 'utf-8');
      }
    }

    // Phase B: mutate (write a second entity, re-export → exports change).
    await store.putEntity({
      id: 'entity/01ROUND-B',
      name: 'EntityB',
      entityType: 'Pattern',
      layer: 'pattern',
      description: 'phase B (post-snapshot)',
      metadata: {},
      createdAt: '2026-06-03T12:01:00Z',
      updatedAt: '2026-06-03T12:01:00Z',
    } as Parameters<GraphKMStore['putEntity']>[0]);
    await store.exportJson();

    // Restore: SnapshotManager reverts exportDir contents to the snapshot tag.
    const restored = await mgr.restoreSnapshot(snap.id);
    expect(restored.restored).toBe(true);
    expect(restored.id).toBe(snap.id);

    // Assert exports byte-equal the snapshot state for the canonical key set.
    for (const f of Object.keys(snapshotState)) {
      const full = path.join(exportDir, f);
      expect(fs.existsSync(full)).toBe(true);
      const after = fs.readFileSync(full, 'utf-8');
      expect(after).toBe(snapshotState[f]);
    }
  });

  test('createSnapshot wraps git commit with OKB_SNAPSHOT=1 env-var (Pitfall 1)', async () => {
    const mgr = new SnapshotManager({ exportDir });

    // Install a fixture pre-commit hook that ENFORCES OKB_SNAPSHOT=1.
    // Without the env-var the hook exits 1 and the commit fails. If SnapshotManager
    // does not wrap its git commit with OKB_SNAPSHOT=1, createSnapshot below throws.
    const hooksDir = path.join(tmpdir, '.git', 'hooks');
    const hookPath = path.join(hooksDir, 'pre-commit');
    fs.writeFileSync(
      hookPath,
      [
        '#!/bin/sh',
        '# Fixture hook: bypass on OKB_SNAPSHOT=1, otherwise block.',
        'if [ "${OKB_SNAPSHOT:-0}" = "1" ]; then',
        '  exit 0',
        'fi',
        'echo "fixture-hook: OKB_SNAPSHOT not set — refusing commit" >&2',
        'exit 1',
      ].join('\n'),
    );
    fs.chmodSync(hookPath, 0o755);

    await store.putEntity({
      id: 'entity/01HOOK',
      name: 'H',
      entityType: 'Component',
      layer: 'evidence',
      description: '',
      metadata: {},
      createdAt: '2026-06-03T12:00:00Z',
      updatedAt: '2026-06-03T12:00:00Z',
    } as Parameters<GraphKMStore['putEntity']>[0]);
    await store.exportJson();

    // If SnapshotManager DOES set OKB_SNAPSHOT=1, this succeeds.
    // If it does NOT, the fixture hook fails the commit and createSnapshot throws.
    const entry = await mgr.createSnapshot('hook-probe');
    expect(entry.id).toMatch(/^snapshot\/hook-probe-/);
  });
});

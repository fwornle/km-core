// Phase 43 Plan 01 — round-trip tests for Entity.layer.
//
// D-G4.2 asks whether km-core supports OKM's `layer: 'evidence' | 'pattern'`
// split. Reading `src/types/entity.ts:27,120` confirms it does — `Layer` is
// the required union OKM uses. No schema change needed (Outcome A in the
// plan). This file proves the contract end-to-end: both layer values survive
// putEntity → getEntity → iterate → exportJson without mutation, so OKM
// consumers (post-Plan-04) can swap to km-core's canonical Entity with
// confidence.

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  GraphKMStore,
  mintEntityId,
  type ProvenanceStamp,
} from '../../src/index.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PROV: ProvenanceStamp = {
  provider: 'test',
  model: 'test-model',
  runId: 'phase-43-01-layer-roundtrip',
  timestamp: '2026-05-31T00:00:00.000Z',
};

type Ctx = { store: GraphKMStore; tmpdir: string; exportDir: string };

function makeStore(): Ctx {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-43-01-'));
  const exportDir = path.join(tmpdir, 'exports');
  const store = new GraphKMStore({
    dbPath: path.join(tmpdir, 'leveldb'),
    exportDir,
    debounceMs: 0,
  });
  return { store, tmpdir, exportDir };
}

describe('Entity.layer round-trip (Phase 43 D-G4.2 verification)', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = makeStore();
    await ctx.store.open();
  });

  afterEach(async () => {
    await ctx.store.close();
    fs.rmSync(ctx.tmpdir, { recursive: true, force: true });
  });

  test("layer:'evidence' survives putEntity → getEntity unchanged", async () => {
    const id = await ctx.store.putEntity(
      {
        id: mintEntityId(),
        name: 'EvidenceFixture',
        entityType: 'Component',
        layer: 'evidence',
        description: 'An evidence-layer entity.',
        createdAt: '2026-05-31T00:00:00Z',
        updatedAt: '2026-05-31T00:00:00Z',
        metadata: { domain: 'general' },
      },
      { provenance: PROV, skipOntologyCheck: true },
    );
    const got = await ctx.store.getEntity(id);
    expect(got).toBeDefined();
    expect(got!.layer).toBe('evidence');
  });

  test("layer:'pattern' survives putEntity → getEntity unchanged (OKM parity)", async () => {
    const id = await ctx.store.putEntity(
      {
        id: mintEntityId(),
        name: 'PatternFixture',
        entityType: 'Component',
        layer: 'pattern',
        description: 'A pattern-layer entity (the OKM use case).',
        createdAt: '2026-05-31T00:00:00Z',
        updatedAt: '2026-05-31T00:00:00Z',
        metadata: { domain: 'general' },
      },
      { provenance: PROV, skipOntologyCheck: true },
    );
    const got = await ctx.store.getEntity(id);
    expect(got).toBeDefined();
    expect(got!.layer).toBe('pattern');

    // Iterator path: same value via the streaming reader OKM's intelligence
    // modules use.
    const seen: string[] = [];
    for await (const e of ctx.store.iterate()) seen.push(e.layer);
    expect(seen).toContain('pattern');
  });

  test("layer:'pattern' survives JSON-export round-trip verbatim", async () => {
    await ctx.store.putEntity(
      {
        id: mintEntityId(),
        name: 'PatternExportFixture',
        entityType: 'Component',
        layer: 'pattern',
        description: 'Round-trip target for exportJson.',
        createdAt: '2026-05-31T00:00:00Z',
        updatedAt: '2026-05-31T00:00:00Z',
        metadata: { domain: 'general' },
      },
      { provenance: PROV, skipOntologyCheck: true },
    );
    await ctx.store.exportJson();

    const exportPath = path.join(ctx.exportDir, 'general.json');
    expect(fs.existsSync(exportPath)).toBe(true);
    const raw = fs.readFileSync(exportPath, 'utf-8');
    // exporter.ts pretty-prints with 2-space indent → `"layer": "pattern"`
    expect(raw).toMatch(/"layer"\s*:\s*"pattern"/);
  });
});

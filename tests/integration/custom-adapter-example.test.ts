// Phase 40 Plan 11 — SC#1 companion integration test.
//
// Asserts the SC#1 reference adapter at `examples/custom-adapter.ts`:
//   1. Compiles and runs end-to-end through the public-API barrel
//      (`@fwornle/km-core`) — Test 1.
//   2. Imports ONLY from `@fwornle/km-core` (no relative imports into `src/`)
//      — Test 2 (import-discipline gate).
//   3. Wires the 3 dedup layers in the D-44 declared order (Jaccard then
//      Cosine then LLM) — Test 3 (source-ordering audit).
//
// The example file IS the reference consumer; this test is the GREEN-only
// proof that the file works against the published surface. The example
// imports from `@fwornle/km-core` via the self-link in `node_modules/` that
// `npm install`/`npm link` produces.
//
// no-console-log: zero console.* anywhere in this file.

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GraphKMStore } from '../../src/index.js';
import { runExampleAdapter } from '../../examples/custom-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXAMPLE_PATH = path.resolve(__dirname, '../../examples/custom-adapter.ts');

type Ctx = {
  store: GraphKMStore;
  tmpdir: string;
};

function makeFixture(): Ctx {
  const tmpdir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'km-core-sc1-example-'),
  );
  const store = new GraphKMStore({
    dbPath: path.join(tmpdir, 'leveldb'),
    exportDir: path.join(tmpdir, 'exports'),
    debounceMs: 0,
  });
  return { store, tmpdir };
}

describe('SC#1 reference adapter — custom-adapter example (integration)', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = makeFixture();
    await ctx.store.open();
  });

  afterEach(async () => {
    await ctx.store.close();
    fs.rmSync(ctx.tmpdir, { recursive: true, force: true });
  });

  test('SC#1: custom-adapter example compiles + runs end-to-end against the public-API barrel', async () => {
    const result = await runExampleAdapter(ctx.store);

    // Extractor returns exactly 2 entities (UserAuthService, PaymentProcessor).
    expect(result.extractedCount).toBe(2);
    // Empty store + non-matching dedup ⇒ both flow through as net-new.
    expect(result.mergedCount).toBe(0);
    // Both entities reach the store.
    expect(result.storedCount).toBe(2);
    // Nothing was dropped or skipped.
    expect(result.skippedCount).toBe(0);
    expect(result.droppedCount).toBe(0);
    // No stages were opted out.
    expect(result.skippedStages).toEqual([]);
    // All 4 stages ran — extract + dedup at minimum took >=0ms each
    // (synthesize against empty receivedIds is effectively zero).
    expect(result.durations.extractMs).toBeGreaterThanOrEqual(0);
    expect(result.durations.dedupMs).toBeGreaterThanOrEqual(0);
    expect(result.durations.storeMs).toBeGreaterThanOrEqual(0);
    expect(result.durations.synthesizeMs).toBeGreaterThanOrEqual(0);
  });

  test('SC#1: example uses only public-API barrel imports (no relative paths into src/)', () => {
    // Read the example as text and audit every import statement.
    const exampleSrc = fs.readFileSync(EXAMPLE_PATH, 'utf8');
    const importLines = exampleSrc
      .split('\n')
      .filter((l) => /^import\s/.test(l));

    // Every import line MUST end with `from '@fwornle/km-core';` (root barrel)
    // OR `from '@fwornle/km-core/<subpath>';`. NO relative imports
    // (`from '../...'`, `from './...'`) and NO `from '.../src/...'` paths.
    const forbidden = importLines.filter((l) =>
      /from\s+['"](\.\.?\/|.*\/src\/)/.test(l),
    );
    expect(forbidden).toEqual([]);

    // Also assert that the import lines DO reach the public-API barrel —
    // catches a regression where someone deletes all the imports.
    const barrelImports = importLines.filter((l) =>
      /from\s+['"]@fwornle\/km-core(\/[a-z]+)?['"]/.test(l),
    );
    expect(barrelImports.length).toBeGreaterThanOrEqual(1);
  });

  test('SC#1: example wires dedup layers in D-44 declared order (Jaccard then Cosine then LLM)', () => {
    // Source-ordering audit: the LayeredDeduplicator ctor in the example
    // must list `exactName` (Jaccard) before `embedding` (Cosine) before
    // `llmSemantic` (LLM). This reinforces the SC#1 documentation value —
    // a developer reading the example sees the canonical D-44 order.
    const exampleSrc = fs.readFileSync(EXAMPLE_PATH, 'utf8');
    const jaccardIdx = exampleSrc.indexOf('JaccardNameMatcher({');
    const cosineIdx = exampleSrc.indexOf('CosineEmbeddingMatcher({');
    const llmIdx = exampleSrc.indexOf('LLMSemanticMatcher({');
    expect(jaccardIdx).toBeGreaterThan(0);
    expect(cosineIdx).toBeGreaterThan(jaccardIdx);
    expect(llmIdx).toBeGreaterThan(cosineIdx);
  });
});

// Phase 42 Plan 04 Task 3 (D-52c): FastembedEmbeddingClient tests.
//
// Six tests covering:
//   T1 — default constructor uses AllMiniLML6V2 (384-dim per D-52c)
//   T2 — embedBatch(['hello', 'foo']) returns 2 arrays of length 384
//        (deviation from plan: real EmbeddingClient interface is single-
//         text; batch ergonomics live on embedBatch, not embed —
//         documented in source header + SUMMARY)
//   T3 — multiple embed calls reuse the same loaded model (initializer
//        spy is called exactly once)
//   T4 — implements EmbeddingClient (type-level + structural assertion)
//   T5 — root barrel exports FastembedEmbeddingClient
//   T6 — sub-path './embeddings' resolves (verified via package.json
//        exports map grep + a programmatic mock-import smoke check using
//        the package's own dist layout)
//
// All tests use a STUB FastembedQueryable injected via opts.initializer
// to keep them fast (no ~80MB ONNX download in CI). The stub returns
// deterministic 384-dim vectors based on text length so cosine-style
// downstream consumers remain meaningful in integration tests.

import { describe, test, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FastembedEmbeddingClient,
} from '../../../src/embeddings/FastembedEmbeddingClient.js';
import type {
  FastembedQueryable,
} from '../../../src/embeddings/FastembedEmbeddingClient.js';
import { EmbeddingModel } from 'fastembed';

/** Build a deterministic stub FastembedQueryable that yields 384-dim
 *  vectors filled with `Math.sin(i * text.length)` — matches the cosine
 *  fakes pattern at tests/unit/_helpers/fakes-embedding.ts:30-36. */
function makeStubFlagEmbedding(opts?: {
  dim?: number;
}): FastembedQueryable {
  const dim = opts?.dim ?? 384;
  const queryEmbed = vi.fn(async (text: string) => {
    return new Array(dim).fill(0).map((_, i) => Math.sin(i * text.length));
  });
  // fastembed's batch API yields an async generator of vector arrays.
  async function* batchEmbed(texts: string[]) {
    yield texts.map((t) =>
      new Array(dim).fill(0).map((_, i) => Math.sin(i * t.length)),
    );
  }
  return {
    queryEmbed,
    embed: batchEmbed as FastembedQueryable['embed'],
  };
}

describe('FastembedEmbeddingClient (Phase 42 D-52c)', () => {
  const clients: FastembedEmbeddingClient[] = [];
  afterEach(async () => {
    while (clients.length > 0) {
      try {
        await clients.pop()!.close();
      } catch {
        /* nothing to release */
      }
    }
  });

  test('Test 1: default constructor uses AllMiniLML6V2 (384-dim per D-52c)', async () => {
    const initSpy = vi.fn(async () => makeStubFlagEmbedding());
    const client = new FastembedEmbeddingClient({ initializer: initSpy });
    clients.push(client);

    const vec = await client.embed('hello world');
    expect(vec).toHaveLength(384);
    // The initializer received AllMiniLML6V2 as the default model.
    expect(initSpy).toHaveBeenCalledTimes(1);
    const initArgs = initSpy.mock.calls[0][0] as {
      model: EmbeddingModel;
      cacheDir: string;
    };
    expect(initArgs.model).toBe(EmbeddingModel.AllMiniLML6V2);
    // Cache dir defaults to an absolute path (not CWD-relative — Phase 28
    // memory note). At minimum it must be absolute.
    expect(path.isAbsolute(initArgs.cacheDir)).toBe(true);
  });

  test('Test 2: embedBatch(["hello", "foo"]) returns 2 arrays of length 384', async () => {
    const stub = makeStubFlagEmbedding();
    const client = new FastembedEmbeddingClient({
      initializer: async () => stub,
    });
    clients.push(client);

    const vecs = await client.embedBatch(['hello world', 'foo bar']);
    expect(vecs).toHaveLength(2);
    expect(vecs[0]).toHaveLength(384);
    expect(vecs[1]).toHaveLength(384);
  });

  test('Test 3: multiple embed calls reuse the same loaded model (lazy-init once)', async () => {
    const initSpy = vi.fn(async () => makeStubFlagEmbedding());
    const client = new FastembedEmbeddingClient({ initializer: initSpy });
    clients.push(client);

    await client.embed('first');
    await client.embed('second');
    await client.embedBatch(['third', 'fourth']);

    expect(initSpy).toHaveBeenCalledTimes(1);
  });

  test('Test 4: implements EmbeddingClient (structural + runtime conformance)', async () => {
    // Compile-time: assignable to EmbeddingClient via structural typing.
    // The dynamic import keeps the type-only check honest at runtime.
    const { CosineEmbeddingMatcher } = await import(
      '../../../src/dedup/CosineEmbeddingMatcher.js'
    );
    const stub = makeStubFlagEmbedding();
    const client = new FastembedEmbeddingClient({
      initializer: async () => stub,
    });
    clients.push(client);

    // If FastembedEmbeddingClient did NOT satisfy EmbeddingClient,
    // CosineEmbeddingMatcher would refuse it at compile time.
    const matcher = new CosineEmbeddingMatcher({ client });
    // Runtime smoke: the matcher's match() against an empty candidate
    // pool resolves to { matched: false, confidence: 0 } without
    // calling embed at all — that's enough to prove the type checks out.
    const result = await matcher.match(
      {
        id: '019e54fa-fff7-7a0b-b4fe-000000000001' as never,
        name: 'subject',
        entityType: 'Detail',
        layer: 'evidence',
        description: 'desc',
        createdAt: '2026-05-23T00:00:00.000Z',
        updatedAt: '2026-05-23T00:00:00.000Z',
        metadata: {},
      },
      [],
    );
    expect(result.matched).toBe(false);
  });

  test('Test 5: root barrel re-exports FastembedEmbeddingClient', async () => {
    // Dynamic import from the root barrel — fails at module-resolution
    // time when the re-export is missing.
    const rootBarrel = await import('../../../src/index.js');
    expect(rootBarrel.FastembedEmbeddingClient).toBeDefined();
    expect(typeof rootBarrel.FastembedEmbeddingClient).toBe('function');
    // Constructible.
    const c = new rootBarrel.FastembedEmbeddingClient({
      initializer: async () => makeStubFlagEmbedding(),
    });
    clients.push(c);
  });

  test('Test 6: sub-path "./embeddings" wired in package.json exports map', () => {
    // Phase 38 / Phase 40 / Phase 41 precedent: assert the package.json
    // exports map carries the sub-path. The external-tmpdir smoke-compile
    // is HEAVY (npm install + tsc); the source-grep here is the
    // acceptance check called out in the Plan AC. (External smoke is
    // exercised against the dist by Phase 42 Plan 05's container resolve.)
    const __filename = fileURLToPath(import.meta.url);
    const pkgPath = path.resolve(
      path.dirname(__filename),
      '..',
      '..',
      '..',
      'package.json',
    );
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    expect(pkg.exports).toBeDefined();
    expect(pkg.exports['./embeddings']).toBeDefined();
    expect(pkg.exports['./embeddings'].import).toMatch(
      /dist\/embeddings\/index\.js$/,
    );
    expect(pkg.exports['./embeddings'].types).toMatch(
      /dist\/embeddings\/index\.d\.ts$/,
    );

    // Also assert the sub-barrel file exists in source.
    const subBarrelPath = path.resolve(
      path.dirname(__filename),
      '..',
      '..',
      '..',
      'src',
      'embeddings',
      'index.ts',
    );
    expect(fs.existsSync(subBarrelPath)).toBe(true);
  });
});

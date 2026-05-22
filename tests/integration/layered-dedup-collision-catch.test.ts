// Phase 40 Plan 06b — ROADMAP SC#2 verification (VALIDATION row 40-T19).
//
// This is the canonical SC#2 contract test for Phase 40 — load-bearing for
// the phase verification gate. It exercises ALL THREE real layer matchers
// (JaccardNameMatcher + CosineEmbeddingMatcher + LLMSemanticMatcher) against
// a single 3-collision batch and proves that each layer catches its
// dedicated collision in declared order, that the short-circuit contract
// prevents downstream layers from being called for upstream matches, and
// that the Phase 39 D-33 supersession path fires automatically once an
// LLM-layer match resolves.
//
// The synthetic-batch design comes verbatim from 40-RESEARCH offset 960-976
// — three seeded survivors of class `Component`:
//
//   1. `UserAuthService` — caught by Jaccard (exactName layer, Layer 1).
//      The extracted entity has the same name; words-set similarity = 1.0,
//      well above 0.85 default threshold.
//
//   2. `CartCheckoutService` — caught by cosine embedding (Layer 2).
//      The extracted entity `CartCheckoutFlow` has a fake-embedding vector
//      crafted to produce cosine 0.93 against this seed; Jaccard score = 0.
//
//   3. `PaymentProcessor` — caught by LLM semantic (Layer 3). Extracted
//      entity `BillingService` has Jaccard = 0 AND cosine 0.40 (below 0.90
//      default), so falls through to the LLM, which returns
//      `{ matches: [{ newName: 'BillingService', existingName:
//      'PaymentProcessor' }] }`.
//
// LOAD-BEARING assertion: `llmClient.complete.mock.calls.length === 1`.
// This proves both upper-layer short-circuits fired (entity #1 stopped at
// Jaccard, entity #2 stopped at cosine — neither hit the LLM). Without the
// short-circuit, every entity would burn an LLM call.
//
// Additional assertions:
//   - mergedCount === 3, storedCount === 3.
//   - skippedStages === [].
//   - For each match: store.getSupersessionChain(<new id>) returns
//     [<original survivor>, <new entity>] — confirming Phase 39 D-33's
//     atomic closure fired through the pipeline for ALL three layers'
//     verdicts (not just exactName).
//
// no-console-log: this test file uses neither console.* nor direct stderr
// writes; layer diagnostics live in src/dedup/*. Spies are vitest's vi.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GraphKMStore } from '../../src/index.js';
import { IngestPipeline } from '../../src/pipeline/IngestPipeline.js';
import { LayeredDeduplicator } from '../../src/dedup/LayeredDeduplicator.js';
import { JaccardNameMatcher } from '../../src/dedup/JaccardNameMatcher.js';
import { CosineEmbeddingMatcher } from '../../src/dedup/CosineEmbeddingMatcher.js';
import { LLMSemanticMatcher } from '../../src/dedup/LLMSemanticMatcher.js';
import type { Entity } from '../../src/index.js';
import type { EntityId } from '../../src/index.js';
import {
  PROV,
  makeFakeExtractor,
  makeFakeSynthesizer,
  mkEntity,
} from '../unit/_helpers/fakes.js';
import { makeFakeEmbeddingClient } from '../unit/_helpers/fakes-embedding.js';
import { makeMockLLMClient } from '../unit/_helpers/fakes-llm.js';

type Ctx = {
  store: GraphKMStore;
  tmpdir: string;
};

function makeFixture(): Ctx {
  const tmpdir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'km-core-pipeline-int-sc2-'),
  );
  const store = new GraphKMStore({
    dbPath: path.join(tmpdir, 'leveldb'),
    exportDir: path.join(tmpdir, 'exports'),
    debounceMs: 0,
  });
  return { store, tmpdir };
}

// `CosineEmbeddingMatcher`'s default `textOf` returns
// `"${name}\n\n${description}".trim()` — we mirror that here so the Map keys
// align with the matcher's lookups.
function textOf(entity: { name: string; description?: string }): string {
  return `${entity.name}\n\n${entity.description ?? ''}`.trim();
}

describe('Layered dedup — SC#2 synthetic collision batch (integration)', () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = makeFixture();
    await ctx.store.open();
  });

  afterEach(async () => {
    await ctx.store.close();
    fs.rmSync(ctx.tmpdir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test('SC#2: synthetic 3-collision batch — exactName / embedding / llmSemantic each catch their respective collision in declared order (3-collision order)', async () => {
    // ---- Seed 3 Component-class entities (one per layer-target) -----------
    const seed1Id = '0192a000-0000-7000-8000-000000000801' as EntityId;
    const seed1 = {
      id: seed1Id,
      name: 'UserAuthService',
      entityType: 'Component',
      ontologyClass: 'Component',
      description: 'Handles login flow',
      validFrom: '2026-05-18T00:00:00.000Z',
    };
    await ctx.store.putEntity(seed1, { provenance: PROV });

    const seed2Id = '0192a000-0000-7000-8000-000000000802' as EntityId;
    const seed2 = {
      id: seed2Id,
      name: 'CartCheckoutService',
      entityType: 'Component',
      ontologyClass: 'Component',
      description: 'Handles cart-to-payment transition',
      validFrom: '2026-05-18T00:00:00.000Z',
    };
    await ctx.store.putEntity(seed2, { provenance: PROV });

    const seed3Id = '0192a000-0000-7000-8000-000000000803' as EntityId;
    const seed3 = {
      id: seed3Id,
      name: 'PaymentProcessor',
      entityType: 'Component',
      ontologyClass: 'Component',
      description: 'Adapter for Stripe + Braintree',
      validFrom: '2026-05-18T00:00:00.000Z',
    };
    await ctx.store.putEntity(seed3, { provenance: PROV });

    // ---- Extracted batch (3 entities, one per layer-target) ---------------
    const newId1 = '0192a000-0000-7000-8000-000000000901' as EntityId;
    const newE1 = mkEntity({
      id: newId1,
      name: 'UserAuthService', // identical → Jaccard = 1.0 → match at exactName
      entityType: 'Component',
      ontologyClass: 'Component',
      description: 'Refined description of the user-auth service',
      validFrom: '2026-05-22T00:00:00.000Z',
    });

    const newId2 = '0192a000-0000-7000-8000-000000000902' as EntityId;
    const newE2 = mkEntity({
      id: newId2,
      // Different name → Jaccard 0 → falls through to embedding layer where
      // the fake embedding produces cosine 0.93 vs CartCheckoutService.
      name: 'CartCheckoutFlow',
      entityType: 'Component',
      ontologyClass: 'Component',
      description: 'Newer phrasing of the same checkout transition',
      validFrom: '2026-05-22T00:00:00.000Z',
    });

    const newId3 = '0192a000-0000-7000-8000-000000000903' as EntityId;
    const newE3 = mkEntity({
      id: newId3,
      // Different name → Jaccard 0; embedding 0.40 (below 0.90) → falls
      // through to LLM, which returns BillingService === PaymentProcessor.
      name: 'BillingService',
      entityType: 'Component',
      ontologyClass: 'Component',
      description: 'Stripe + Braintree adapter, refactored',
      validFrom: '2026-05-22T00:00:00.000Z',
    });

    // ---- Real layer matchers + fake embedding/LLM clients ----------------
    //
    // 5-dim vectors with carefully chosen overlap so that:
    //   - CartCheckoutFlow vs CartCheckoutService → cosine 0.93
    //   - BillingService   vs PaymentProcessor    → cosine 0.40
    //   - all other pairs                          → 0
    //
    // Vector layout:
    //   axis 0 — CartCheckout (CartCheckoutService primary; CartCheckoutFlow
    //            shares this axis weighted at 0.93)
    //   axis 1 — orthogonal padding for CartCheckoutFlow (sqrt(1 - 0.93^2))
    //   axis 2 — UserAuthService primary axis
    //   axis 3 — PaymentProcessor primary axis (BillingService rides this
    //            axis at 0.40 → cosine 0.40)
    //   axis 4 — BillingService padding (sqrt(1 - 0.4^2) ≈ 0.9165)
    //
    // All vectors are unit-length so cosine === dot product.
    const orthogonalCart = Math.sqrt(1 - 0.93 * 0.93); // ≈ 0.36769
    const billingPad = Math.sqrt(1 - 0.4 * 0.4); // ≈ 0.91652
    const embeddings = new Map<string, number[]>([
      [textOf(seed2), [1, 0, 0, 0, 0]], // CartCheckoutService
      [textOf(newE2), [0.93, orthogonalCart, 0, 0, 0]], // CartCheckoutFlow
      [textOf(seed1), [0, 0, 1, 0, 0]], // UserAuthService (seed)
      [textOf(newE1), [0, 0, 1, 0, 0]], // UserAuthService (new) — same axis;
      // not relevant because Jaccard short-circuits this entity before
      // embedding runs, but defining for completeness so any test crawl that
      // hits embedding for this text still gets a deterministic vector.
      [textOf(seed3), [0, 0, 0, 1, 0]], // PaymentProcessor
      [textOf(newE3), [0, 0, 0, 0.4, billingPad]], // BillingService → cosine 0.4
    ]);
    const embeddingClient = makeFakeEmbeddingClient({ embeddings });

    // LLM returns a single match for BillingService → PaymentProcessor;
    // returns matches for ANY call (no per-call discrimination needed
    // because the upper layers short-circuit before hitting the LLM for
    // entities #1 and #2).
    const llmClient = makeMockLLMClient({
      matches: [{ newName: 'BillingService', existingName: 'PaymentProcessor' }],
    });

    const deduplicator = new LayeredDeduplicator({
      exactName: new JaccardNameMatcher(), // default threshold 0.85
      embedding: new CosineEmbeddingMatcher({ client: embeddingClient }), // default 0.90
      llmSemantic: new LLMSemanticMatcher({ client: llmClient }), // default 0.70
    });

    const extractor = makeFakeExtractor([newE1, newE2, newE3]);
    const synthesizer = makeFakeSynthesizer();

    const pipeline = new IngestPipeline(ctx.store, {
      extractor,
      deduplicator,
      synthesizer,
    });

    const result = await pipeline.ingest('synthetic 3-collision batch', {
      provenance: PROV,
    });

    // ---- ROADMAP SC#2 assertions ----------------------------------------

    // All three entities matched.
    expect(result.mergedCount).toBe(3);
    expect(result.storedCount).toBe(3);
    expect(result.skippedStages).toEqual([]);

    // LOAD-BEARING: LLM called exactly once — proves both upper-layer
    // short-circuits fired. Entity #1 (UserAuthService) stopped at the
    // exactName layer (Jaccard 1.0 ≥ 0.85). Entity #2 (CartCheckoutFlow)
    // stopped at the embedding layer (cosine 0.93 ≥ 0.90). Only entity #3
    // (BillingService) fell through to the LLM.
    //
    // Two equivalent forms — the explicit `.mock.calls.length` form is
    // the one quoted verbatim in 40-06b-PLAN acceptance criteria.
    expect(llmClient.complete).toHaveBeenCalledTimes(1);
    expect(
      (llmClient.complete as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
    ).toBe(1);

    // Embedding called at least once — entity #2 needs it. Entity #3 also
    // calls embed() because the embedding layer runs (and falls through
    // because score 0.40 < 0.90). Entity #1 short-circuits at exactName
    // BEFORE the embedding layer runs, so its embeddings are not fetched.
    expect((embeddingClient.embed as unknown as { mock: { calls: unknown[] } }).mock.calls.length)
      .toBeGreaterThan(0);

    // Phase 39 D-33 atomic closure fired for ALL THREE matches:
    //
    //   Jaccard match    — seed1 (UserAuthService) is now superseded by newE1.
    //   Cosine match     — seed2 (CartCheckoutService) is superseded by newE2.
    //   LLMSemantic match — seed3 (PaymentProcessor) is superseded by newE3.
    const chain1 = await ctx.store.getSupersessionChain(newId1);
    expect(chain1.map((e) => e.id)).toEqual([seed1Id, newId1]);

    const chain2 = await ctx.store.getSupersessionChain(newId2);
    expect(chain2.map((e) => e.id)).toEqual([seed2Id, newId2]);

    // The BillingService-via-LLM chain — proves the LLM-layer verdict
    // routes through the SAME putEntity({...entity, supersedes: survivor.id})
    // codepath as the upper layers, and Phase 39's atomic closure fires
    // identically regardless of which layer produced the match.
    const chain3 = await ctx.store.getSupersessionChain(newId3);
    expect(chain3.map((e) => e.id)).toEqual([seed3Id, newId3]);

    // Sanity: each seed's validUntil is now stamped (D-33 closure fired).
    const closed1 = (await ctx.store.getEntity(seed1Id))!;
    const closed2 = (await ctx.store.getEntity(seed2Id))!;
    const closed3 = (await ctx.store.getEntity(seed3Id))!;
    expect(closed1.validUntil).toBe(newE1.validFrom);
    expect(closed2.validUntil).toBe(newE2.validFrom);
    expect(closed3.validUntil).toBe(newE3.validFrom);
  });
});

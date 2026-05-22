/**
 * Reference adapter for SC#1 — demonstrates Phase 40's pluggable stage
 * interfaces with no fork required.
 *
 * Implements all four stage interfaces (Extractor + Synthesizer + the 3
 * dedup-layer client interfaces EmbeddingClient + LLMClient that drive
 * JaccardNameMatcher / CosineEmbeddingMatcher / LLMSemanticMatcher) and
 * wires them into an IngestPipeline. Run as a smoke test — no Docker,
 * no external services required.
 *
 * Import-discipline: this file imports ONLY from `@fwornle/km-core` (the
 * public-API barrel landed by Plan 40-07). A downstream consumer in a
 * different repo would do exactly the same `import { ... } from
 * '@fwornle/km-core'` — no relative paths into the km-core source tree,
 * no fork of pipeline.ts. The package.json `exports` map (`.`, `./pipeline`,
 * `./dedup`, `./ontology`) is the only legal entry point; this example
 * sticks to the root barrel for maximum simplicity.
 *
 * SC#1 manual-verification anchor — see 40-VERIFICATION.md (human_verification
 * item) and 40-VALIDATION.md row "Manual-Only SC#1".
 */

import { IngestPipeline, LayeredDeduplicator, JaccardNameMatcher, CosineEmbeddingMatcher, LLMSemanticMatcher, GraphKMStore, mintEntityId } from '@fwornle/km-core';
import type { Extractor, Synthesizer, EmbeddingClient, LLMClient, Entity, EntityId, ProvenanceStamp, IngestResult } from '@fwornle/km-core';

/**
 * Minimal Extractor stub — returns 2 hardcoded `Component` entities. A real
 * adapter would parse `text` (and optionally scope to `domain`) and emit
 * the entities it finds; this stub ignores both inputs to keep the smoke
 * test deterministic. The post-CR-04 contract `extract(text, domain?)` is
 * honored even though `domain` is unused here.
 */
const exampleExtractor: Extractor = {
  async extract(_text: string, _domain?: string): Promise<Entity[]> {
    const now = new Date().toISOString();
    const baseEntity = (name: string): Entity => ({
      id: mintEntityId(),
      name,
      entityType: 'Component',
      ontologyClass: 'Component',
      layer: 'evidence',
      description: `Example entity ${name} produced by the SC#1 reference extractor.`,
      createdAt: now,
      updatedAt: now,
      metadata: {},
      validFrom: now,
    });
    return [baseEntity('UserAuthService'), baseEntity('PaymentProcessor')];
  },
};

/**
 * Synthesizer factory — returns `{ synthesizer, receivedIds }` so callers
 * (and the companion integration test) can observe which survivor IDs the
 * synthesize stage saw. The synthesizer itself is a no-op apart from
 * pushing the IDs into the closure array; a real adapter would build
 * digests / insight documents over the survivor set.
 */
export function createExampleSynthesizer(): {
  synthesizer: Synthesizer;
  receivedIds: EntityId[];
} {
  const receivedIds: EntityId[] = [];
  const synthesizer: Synthesizer = {
    async synthesize(
      survivorIds: EntityId[],
      _opts: { provenance: ProvenanceStamp },
    ): Promise<void> {
      for (const id of survivorIds) receivedIds.push(id);
    },
  };
  return { synthesizer, receivedIds };
}

/**
 * Minimal EmbeddingClient stub — returns a fixed unit vector for every
 * input. Real adapters wire fastembed / Qdrant / OpenAI here.
 */
const exampleEmbeddingClient: EmbeddingClient = {
  async embed(_text: string): Promise<number[]> {
    return [1, 0, 0];
  },
};

/**
 * Minimal LLMClient stub — returns the canonical empty-matches response
 * the LLM-semantic layer expects when no duplicates are detected. Real
 * adapters wire groq / haiku / rapid-llm-proxy here.
 */
const exampleLLMClient: LLMClient = {
  async complete(_req): Promise<{ content: string }> {
    return { content: '{"matches":[]}' };
  },
};

/**
 * Layered deduplicator wired with the D-44 declared order (Jaccard then
 * Cosine then LLM) and the canonical thresholds documented in 40-CONTEXT:
 * exact-name 0.85, embedding 0.90, LLM-semantic 0.70.
 */
const exampleDeduplicator = new LayeredDeduplicator({
  exactName: new JaccardNameMatcher({ threshold: 0.85 }),
  embedding: new CosineEmbeddingMatcher({
    client: exampleEmbeddingClient,
    threshold: 0.90,
  }),
  llmSemantic: new LLMSemanticMatcher({
    client: exampleLLMClient,
    threshold: 0.70,
  }),
});

/**
 * Public factory invoked by `tests/integration/custom-adapter-example.test.ts`.
 * Constructs an `IngestPipeline` via the D-42 options-object ctor against
 * the caller-supplied `GraphKMStore`, then runs the ingest() call per
 * D-43 with `{ provenance, domain }`.
 */
export async function runExampleAdapter(
  store: GraphKMStore,
): Promise<IngestResult> {
  const { synthesizer } = createExampleSynthesizer();
  const pipeline = new IngestPipeline(store, {
    extractor: exampleExtractor,
    deduplicator: exampleDeduplicator,
    synthesizer,
  });
  const provenance: ProvenanceStamp = {
    provider: 'example',
    model: 'sc1-reference-adapter',
    runId: 'sc1-' + Date.now(),
    timestamp: new Date().toISOString(),
  };
  return await pipeline.ingest(
    'some sample text — the example extractor ignores this',
    { provenance, domain: 'coding' },
  );
}

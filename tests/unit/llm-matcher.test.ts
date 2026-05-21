// Phase 40 Plan 04: LLMSemanticMatcher unit tests (DEDUP-01 layer 3 of 3).
//
// Verifies the port of OKM's batchLLMDedup prompt + 5-stage JSON-unwrap
// (`deduplicator.ts:421-475`) into `LLMSemanticMatcher`. Test names mirror
// 40-PATTERNS.md offset 771-780; the 5-stage JSON unwrap is exercised via
// 4 distinct `raw` payloads + the empty-candidates fast path.
//
// no-console-log: the `onError: 'skip'` test spies on `process.stderr.write`
// (matches the production emission path in src/dedup/LLMSemanticMatcher.ts
// and the broader Phase 37/38/39 stderr-warn convention).

import { describe, test, expect, vi } from 'vitest';
import {
  LLMSemanticMatcher,
  type LLMClient,
} from '../../src/dedup/LLMSemanticMatcher.js';
import { mkEntity } from './_helpers/fakes.js';
import { makeMockLLMClient } from './_helpers/fakes-llm.js';

describe('LLMSemanticMatcher', () => {
  test('returns matched: false when candidates is empty', async () => {
    const client = makeMockLLMClient({ matches: [] });
    const matcher = new LLMSemanticMatcher({ client });
    const entity = mkEntity({ name: 'BillingService' });

    const result = await matcher.match(entity, []);

    expect(result.matched).toBe(false);
    expect(result.confidence).toBe(0);
    expect(result.survivor).toBeUndefined();
    expect(client.complete).not.toHaveBeenCalled();
  });

  test('parses bare JSON response', async () => {
    const raw =
      '{"matches":[{"newName":"BillingService","existingName":"PaymentProcessor"}]}';
    const client = makeMockLLMClient({ raw });
    const matcher = new LLMSemanticMatcher({ client });
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000001' as unknown as ReturnType<
        typeof mkEntity
      >['id'],
      name: 'BillingService',
    });
    const candidate = mkEntity({
      id: '0192a000-0000-7000-8000-000000000002' as unknown as ReturnType<
        typeof mkEntity
      >['id'],
      name: 'PaymentProcessor',
    });

    const result = await matcher.match(entity, [candidate]);

    expect(result.matched).toBe(true);
    expect(result.survivor?.name).toBe('PaymentProcessor');
    expect(result.confidence).toBe(0.7);
  });

  test('unwraps anchored markdown fence \\n```json\\n{...}\\n``` ', async () => {
    const inner =
      '{"matches":[{"newName":"BillingService","existingName":"PaymentProcessor"}]}';
    const raw = '```json\n' + inner + '\n```';
    const client = makeMockLLMClient({ raw });
    const matcher = new LLMSemanticMatcher({ client });
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000001' as unknown as ReturnType<
        typeof mkEntity
      >['id'],
      name: 'BillingService',
    });
    const candidate = mkEntity({
      id: '0192a000-0000-7000-8000-000000000002' as unknown as ReturnType<
        typeof mkEntity
      >['id'],
      name: 'PaymentProcessor',
    });

    const result = await matcher.match(entity, [candidate]);

    expect(result.matched).toBe(true);
    expect(result.survivor?.name).toBe('PaymentProcessor');
  });

  test('unwraps unanchored markdown fence (fence in middle of response)', async () => {
    const raw =
      'Sure, here is the JSON:\n```json\n{"matches":[]}\n```\nLet me know if you need anything else.';
    const client = makeMockLLMClient({ raw });
    const matcher = new LLMSemanticMatcher({ client });
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000001' as unknown as ReturnType<
        typeof mkEntity
      >['id'],
      name: 'BillingService',
    });
    const candidate = mkEntity({
      id: '0192a000-0000-7000-8000-000000000002' as unknown as ReturnType<
        typeof mkEntity
      >['id'],
      name: 'PaymentProcessor',
    });

    const result = await matcher.match(entity, [candidate]);

    expect(result.matched).toBe(false);
    expect(result.confidence).toBe(0);
  });

  test('extracts bare braces from prose-wrapped response', async () => {
    const raw =
      'I think these are duplicates: {"matches":[{"newName":"Foo","existingName":"Bar"}]} based on my analysis.';
    const client = makeMockLLMClient({ raw });
    const matcher = new LLMSemanticMatcher({ client });
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000001' as unknown as ReturnType<
        typeof mkEntity
      >['id'],
      name: 'Foo',
    });
    const candidate = mkEntity({
      id: '0192a000-0000-7000-8000-000000000002' as unknown as ReturnType<
        typeof mkEntity
      >['id'],
      name: 'Bar',
    });

    const result = await matcher.match(entity, [candidate]);

    expect(result.matched).toBe(true);
    expect(result.survivor?.name).toBe('Bar');
  });

  test('onError: skip (default) — returns no-match + stderr warn on LLM throw', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const client = makeMockLLMClient({
        throwError: new Error('LLM unreachable'),
      });
      const matcher = new LLMSemanticMatcher({ client });
      const entity = mkEntity({
        id: '0192a000-0000-7000-8000-000000000001' as unknown as ReturnType<
          typeof mkEntity
        >['id'],
        name: 'BillingService',
      });
      const candidate = mkEntity({
        id: '0192a000-0000-7000-8000-000000000002' as unknown as ReturnType<
          typeof mkEntity
        >['id'],
        name: 'PaymentProcessor',
      });

      const result = await matcher.match(entity, [candidate]);

      expect(result.matched).toBe(false);
      expect(result.confidence).toBe(0);

      const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
      expect(calls.some((s) => s.includes('[km-core/dedup/llm]'))).toBe(true);
      expect(calls.some((s) => s.includes('LLM unreachable'))).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  test('onError: throw — re-throws caller-side', async () => {
    const client = makeMockLLMClient({
      throwError: new Error('LLM unreachable'),
    });
    const matcher = new LLMSemanticMatcher({ client, onError: 'throw' });
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000001' as unknown as ReturnType<
        typeof mkEntity
      >['id'],
      name: 'BillingService',
    });
    const candidate = mkEntity({
      id: '0192a000-0000-7000-8000-000000000002' as unknown as ReturnType<
        typeof mkEntity
      >['id'],
      name: 'PaymentProcessor',
    });

    await expect(matcher.match(entity, [candidate])).rejects.toThrow(
      'LLM unreachable',
    );
  });

  test('threshold defaults to 0.70', () => {
    const client = makeMockLLMClient({ matches: [] });
    const matcher = new LLMSemanticMatcher({ client });
    expect(matcher.threshold).toBe(0.7);
  });

  test('sends correct system + user prompt with ontologyClass + existing names', async () => {
    const client = makeMockLLMClient({ matches: [] });
    const matcher = new LLMSemanticMatcher({ client });
    const entity = mkEntity({
      id: '0192a000-0000-7000-8000-000000000001' as unknown as ReturnType<
        typeof mkEntity
      >['id'],
      name: 'BillingService',
      ontologyClass: 'Service',
    });
    const candidate = mkEntity({
      id: '0192a000-0000-7000-8000-000000000002' as unknown as ReturnType<
        typeof mkEntity
      >['id'],
      name: 'PaymentProcessor',
      ontologyClass: 'Service',
    });

    await matcher.match(entity, [candidate]);

    const completeMock = client.complete as unknown as ReturnType<typeof vi.fn>;
    expect(completeMock).toHaveBeenCalledTimes(1);
    const req = completeMock.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
      taskType?: string;
      responseFormat?: { type: string };
      timeout?: number;
    };

    expect(req.messages.length).toBe(2);
    expect(req.messages[0].role).toBe('system');
    expect(req.messages[0].content).toContain('Service');
    expect(req.messages[1].role).toBe('user');
    expect(req.messages[1].content).toContain(JSON.stringify(['BillingService']));
    expect(req.messages[1].content).toContain(JSON.stringify(['PaymentProcessor']));
    expect(req.taskType).toBe('deduplication_matching');
    expect(req.responseFormat).toEqual({ type: 'json_object' });
    expect(req.timeout).toBe(60_000);
  });
});

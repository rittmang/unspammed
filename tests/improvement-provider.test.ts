import { afterEach, describe, expect, it, vi } from 'vitest';
import { replayCostRatio } from '../shared/improvement';
import { defaultSettings } from '../shared/types';
import type { Env } from '../worker/env';
import { applyPolicyEdits, mergePolicyLessons, proposePolicy } from '../worker/improvement';

const env = {
  OPENROUTER_API_KEY: 'test-api-key',
  POLICY_DRAFT_MODEL: defaultSettings.model,
} as Env;
const candidate =
  'Flag deceptive solicitation. Allow ordinary conversation and useful student posts.';

afterEach(() => vi.unstubAllGlobals());

describe('policy drafting provider requests in the Workers runtime', () => {
  it('constructs a valid request and reads the proposed policy and usage', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      // Exercise workerd request validation before returning the mocked provider response.
      const request = new Request(input, init);
      expect(request.url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(request.method).toBe('POST');
      return Response.json({
        model: defaultSettings.model,
        choices: [
          {
            message: {
              content: JSON.stringify({
                edits: [{ before: defaultSettings.policy, after: candidate }],
              }),
            },
          },
        ],
        usage: { total_tokens: 100, cost: 0.00001 },
      });
    });
    vi.stubGlobal('fetch', fetcher);

    expect(
      await proposePolicy(env, defaultSettings, [], 'Clarify deceptive solicitation.'),
    ).toMatchObject({
      policy: candidate,
      usage: { tokens: 100, cost: 0.00001 },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([302, 307])('rejects HTTP %s without following the provider redirect', async (status) => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.redirect).toBe('manual');
      return new Response(null, {
        status,
        headers: { Location: 'https://another-provider.invalid/' },
      });
    });
    vi.stubGlobal('fetch', fetcher);

    await expect(
      proposePolicy(env, defaultSettings, [], 'Clarify deceptive solicitation.'),
    ).rejects.toThrow(`Policy drafting provider returned HTTP ${status}`);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('grounded policy edits', () => {
  it('rejects formatting, headings, introductions, ambiguous matches and overlap', () => {
    expect(() =>
      applyPolicyEdits('Allow greetings and ordinary conversation.', [
        { before: 'Allow greetings', after: 'Allow  greetings' },
      ]),
    ).toThrow(/formatting/);
    expect(() =>
      applyPolicyEdits('**Allowed**', [{ before: '**Allowed**', after: '**Legitimate**' }]),
    ).toThrow(/heading/);
    expect(() =>
      applyPolicyEdits('This is a student community.\n\nSPAM\n\nFlag deceptive solicitation.', [
        { before: 'This is a student community.', after: 'This is an academic community.' },
      ]),
    ).toThrow(/introduction/);
    expect(() =>
      applyPolicyEdits('Allow replies. Allow replies.', [
        { before: 'Allow replies.', after: 'Allow useful replies.' },
      ]),
    ).toThrow(/unique/);
    expect(() =>
      applyPolicyEdits('Flag scams and promotion.', [
        { before: 'Flag scams', after: 'Flag phishing' },
        { before: 'scams and promotion.', after: 'deceptive offers.' },
      ]),
    ).toThrow(/overlap/);
  });
  it('applies short multilingual clauses and derives truthful summaries', () => {
    const before = '禁止诈骗。',
      after = '禁止诈骗和未经请求的商业推广。';
    const policy = '请保持友善并尊重其他成员。' + before;
    expect(applyPolicyEdits(policy, [{ before, after }])).toEqual({
      policy: policy.replace(before, after),
      criteria: [before + ' → ' + after],
    });
  });
  it('retains recently updated old lessons within its bounded memory', () => {
    const lessons = Array.from({ length: 25 }, (_, i) => ({
      source: String(i),
      example: { id: String(i), text: 'Reference', label: 'spam' as const },
    }));
    const memory = mergePolicyLessons([
      ...lessons,
      { ...lessons[0], example: { ...lessons[0].example, text: 'Updated regression' } },
    ]);
    expect(memory).toHaveLength(24);
    expect(memory.at(-1)?.example.text).toBe('Updated regression');
    expect(memory.some((e) => e.source === '1')).toBe(false);
  });
});

describe('bounded cumulative proposal evidence', () => {
  it('keeps originals and recent mistakes while fitting multilingual lessons into the byte limit', async () => {
    let request: any;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        expect(new TextEncoder().encode(String(init.body)).length).toBeLessThanOrEqual(60000);
        request = JSON.parse(String(init.body));
        return Response.json({
          model: defaultSettings.model,
          choices: [
            {
              message: {
                content: JSON.stringify({
                  edits: [{ before: defaultSettings.policy, after: candidate }],
                }),
              },
            },
          ],
        });
      }),
    );
    const lessons = Array.from({ length: 24 }, (_, i) => ({
      source: `source-${i}`,
      example: {
        id: `id-${i}`,
        text: String(i) + '请正确理解此消息'.repeat(300),
        context: ['上下文'.repeat(100)],
        label: 'ham' as const,
      },
      baseline: {
        id: String(i),
        score: 0.1,
        category: 'policy',
        reason: 'A labelled contrast case',
      },
      candidate: {
        id: String(i),
        score: 0.1,
        category: 'policy',
        reason: 'A labelled contrast case',
      },
    }));
    await proposePolicy(
      env,
      defaultSettings,
      [
        {
          example: { id: 'original', text: 'Original owner correction', label: 'spam' },
          prediction: null,
          policy: defaultSettings.policy,
          settings: defaultSettings,
          action: { status: 'label_only' },
        },
      ],
      '',
      {
        campaignId: 'test',
        attempt: 2,
        maxAttempts: 4,
        learnedFamilies: [],
        trainingSources: [],
        history: [],
        lessons,
        revision: {
          previousPolicy: defaultSettings.policy,
          phase: 'development',
          failedChecks: ['correctedFeedback'],
          loss: { baseline: 2, candidate: 2 },
          examples: lessons.slice(-12),
        },
      },
    );
    const data = JSON.parse(request.messages[1].content);
    expect(data.developmentCorrections[0].message).toBe('Original owner correction');
    expect(data.previousAttempt.mistakes.length).toBeGreaterThanOrEqual(3);
    expect(data.cumulativeLessons.length).toBeLessThan(24);
    expect(
      data.cumulativeLessons.every(
        (e: any) => !data.previousAttempt.mistakes.some((m: any) => m.message === e.message),
      ),
    ).toBe(true);
  });
  it('rejects the old unsupported policy and summary response contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({ policy: candidate, criteria: ['Fixed everything'] }),
              },
            },
          ],
        }),
      ),
    );
    await expect(proposePolicy(env, defaultSettings, [], '')).rejects.toThrow();
  });
  it('rejects copied fragments from older cumulative lessons', async () => {
    const text = 'This older private message has eight distinctive words copied directly.';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  edits: [{ before: defaultSettings.policy, after: candidate + ' ' + text }],
                }),
              },
            },
          ],
        }),
      ),
    );
    await expect(
      proposePolicy(env, defaultSettings, [], '', {
        campaignId: 'test',
        attempt: 2,
        maxAttempts: 4,
        learnedFamilies: [],
        trainingSources: [],
        history: [],
        lessons: [{ source: 'older', example: { id: 'older', text, label: 'spam' } }],
      }),
    ).rejects.toThrow(/copied a message fragment/);
  });
});

it('bounds same-route inference growth independently of warm-cache billing discounts', () => {
  expect(
    replayCostRatio(
      { cost: 0.0001, input: 1000, output: 100 },
      { cost: 0.0002, input: 1100, output: 120 },
    ),
  ).toBe(1.2);
  expect(
    replayCostRatio({ cost: 1, input: 1000, output: 100 }, { cost: 1, input: 1100, output: 200 }),
  ).toBe(2);
  expect(
    replayCostRatio(
      { cost: null, input: 1000, output: 100 },
      { cost: 1, input: 1100, output: 120 },
    ),
  ).toBeNull();
  expect(
    replayCostRatio(
      { cost: 1, input: 1000, output: 100, estimated: true },
      { cost: 1, input: 1100, output: 120 },
    ),
  ).toBeNull();
});

it('uses the stronger drafting route while keeping custom endpoints on their configured model', async () => {
  const seen: any[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init.body));
      seen.push(body);
      return Response.json({
        model: body.model,
        choices: [
          {
            message: {
              content: JSON.stringify({
                diagnosis: 'A focused boundary change.',
                edits: [{ before: defaultSettings.policy, after: candidate }],
              }),
            },
          },
        ],
      });
    }),
  );
  await proposePolicy(
    { OPENROUTER_API_KEY: 'test' } as Env,
    defaultSettings,
    [],
    'Clarify solicitation.',
  );
  expect(seen[0].model).toBe('google/gemini-2.5-flash');
  expect(seen[0].reasoning).toEqual({ max_tokens: 2000, exclude: true });
  await proposePolicy(
    {
      OPENROUTER_API_KEY: 'test',
      MODEL_PROVIDERS_JSON: JSON.stringify([
        {
          id: 'openrouter',
          name: 'Custom endpoint',
          baseUrl: 'https://custom.invalid/v1',
          apiKeyEnv: 'OPENROUTER_API_KEY',
          format: 'json_object',
        },
      ]),
    } as Env,
    defaultSettings,
    [],
    'Clarify solicitation.',
  );
  expect(seen[1].model).toBe(defaultSettings.model);
  expect(seen[1].reasoning).toBeUndefined();
});

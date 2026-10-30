import { describe, expect, it, vi, afterEach } from 'vitest';
import { defaultSettings, storedSettings, settingsSchema } from '../shared/types';
import {
  defaultPolicy,
  evaluatedPolicy,
  evaluatedPolicyEdits,
  legacyDefaultPolicy,
} from '../shared/moderation-policy';
import fixture from './fixtures/attention-bait.json';
import {
  requestPayload,
  providers,
  fitExamples,
  estimateTokens,
  classify,
} from '../worker/classifier';
import type { Env } from '../worker/env';

const env = { OPENROUTER_API_KEY: 'fixture-key' } as Env;
const provider = providers(env)[0];
const model = 'google/gemini-2.5-flash-lite';
const examples = [
  { id: 'first', text: 'Please help 😭', label: null, context: ['When is the library open?'] },
  { id: 'second', text: 'Another target', label: null, context: [] },
];
afterEach(() => vi.unstubAllGlobals());

describe('evaluated moderation setup', () => {
  it('preserves exact tested criteria and unrelated community rules during an explicit upgrade', () => {
    expect(evaluatedPolicyEdits).toEqual(fixture.edits);
    let old = defaultPolicy;
    for (const edit of evaluatedPolicyEdits) old = old.replace(edit.after, edit.before);
    const custom = old + '\nKeep the custom community rule.';
    expect(evaluatedPolicy(custom)).toBe(defaultPolicy + '\nKeep the custom community rule.');
    expect(evaluatedPolicy(evaluatedPolicy(custom))).toBe(evaluatedPolicy(custom));
    expect(evaluatedPolicy(legacyDefaultPolicy)).toBe(defaultPolicy);
    expect(() => evaluatedPolicy('An unrelated custom policy with different criteria.')).toThrow(
      'manual review',
    );
    expect(defaultPolicy).not.toContain('MIT-WPU');
  });

  it('starts new groups with the requested setup and preserves old configurations and snapshots', () => {
    expect(defaultSettings).toMatchObject({
      mode: 'observe',
      batchSize: 1,
      reasoningTokens: 1024,
      policy: defaultPolicy,
    });
    const { reasoningTokens: _thinking, batchSize: _batch, ...old } = defaultSettings;
    expect(storedSettings({ ...old, policy: legacyDefaultPolicy })).toMatchObject({
      reasoningTokens: 0,
      batchSize: 20,
      policy: legacyDefaultPolicy,
    });
    expect(storedSettings(defaultSettings)).toEqual(defaultSettings);
    expect(storedSettings({})).toMatchObject({
      batchSize: 20,
      reasoningTokens: 0,
      policy: legacyDefaultPolicy,
      mode: 'observe',
    });
    expect(settingsSchema.parse({ reasoningTokens: 8192 }).reasoningTokens).toBe(8192);
    expect(() => settingsSchema.parse({ reasoningTokens: -1 })).toThrow();
    expect(() => settingsSchema.parse({ reasoningTokens: 65537 })).toThrow();
  });

  it('sends the audited budget, keeps output headroom, and refuses accidental multi-message thinking calls', async () => {
    const payload = requestPayload(
      provider,
      model,
      defaultPolicy,
      examples.slice(0, 1),
      defaultSettings,
    );
    expect(payload).toMatchObject({
      reasoning: { max_tokens: 1024, exclude: true },
      provider: { only: ['google-ai-studio'], allow_fallbacks: false },
      max_tokens: 2024,
      temperature: 0,
    });
    expect(JSON.parse((payload as any).messages[1].content).messages[0]).toMatchObject({
      text: examples[0].text,
      recent_same_sender: examples[0].context,
    });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(
      classify(env, 'openrouter', model, defaultPolicy, examples, defaultSettings),
    ).rejects.toThrow('exactly one');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reserves thinking in the live budget and caps fitted calls without truncating context', () => {
    const options = { ...defaultSettings, batchSize: 20 };
    const withThinking = estimateTokens(
      env,
      'openrouter',
      model,
      defaultPolicy,
      examples.slice(0, 1),
      options,
    );
    const withoutThinking = estimateTokens(
      env,
      'openrouter',
      model,
      defaultPolicy,
      examples.slice(0, 1),
      { ...options, reasoningTokens: 0 },
    );
    expect(withThinking - withoutThinking).toBeGreaterThanOrEqual(1024);
    expect(
      fitExamples(env, 'openrouter', model, defaultPolicy, examples, withThinking, options),
    ).toEqual(examples.slice(0, 1));
    expect(
      fitExamples(env, 'openrouter', model, defaultPolicy, examples, withThinking - 1, options),
    ).toEqual([]);
    expect(
      fitExamples(env, 'openrouter', model, defaultPolicy, examples, Infinity, {
        ...options,
        reasoningTokens: 0,
      }),
    ).toEqual(examples);
  });

  it('does not send Gemini reasoning parameters to decision models, other models or custom URL overrides', () => {
    for (const [route, selected] of [
      [provider, 'another/model'],
      [{ ...provider, format: 'decisions' as const }, model],
      [{ ...provider, baseUrl: 'https://custom.example/v1' }, model],
    ] as const) {
      expect(
        requestPayload(route, selected, defaultPolicy, examples, defaultSettings),
      ).not.toHaveProperty('reasoning');
      expect(
        requestPayload(route, selected, defaultPolicy, examples, defaultSettings),
      ).not.toHaveProperty('provider');
    }
  });
});

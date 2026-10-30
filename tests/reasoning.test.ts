import { describe, expect, it } from 'vitest';
import { defaultSettings, settingsSchema, storedSettings } from '../shared/types';
import { modelReasoningOptions, settingsForModel, thinkingMode } from '../shared/reasoning';
import {
  estimateTokens,
  fitExamples,
  providers,
  publicProviders,
  requestPayload,
} from '../worker/classifier';
import type { Env } from '../worker/env';

const env = { OPENROUTER_API_KEY: 'fixture-key' } as Env;
const provider = providers(env)[0];
const examples = [
  { id: 'a', text: 'A legitimate question', label: null },
  { id: 'b', text: 'A second question', label: null },
];

describe('model-independent thinking controls', () => {
  it('keeps a model’s explicit overrides out of different lab or image-fallback routes', () => {
    const current = settingsSchema.parse({
      reasoningMode: 'effort',
      reasoningEffort: 'high',
      maxOutputTokens: 16384,
      modelEndpoint: 'fixture-provider',
    });
    expect(settingsForModel(current, current.provider, current.model)).toBe(current);
    expect(settingsForModel(current, 'openrouter', 'different/model')).toMatchObject({
      reasoningMode: 'default',
      reasoningTokens: 0,
      model: 'different/model',
      reasoningEffort: undefined,
      maxOutputTokens: undefined,
      modelEndpoint: undefined,
    });
    expect(
      settingsForModel(defaultSettings, 'openrouter', 'legacy/other').reasoningMode,
    ).toBeUndefined();
  });

  it('uses arbitrary token budgets for future models and keeps batching independent', () => {
    const settings = settingsSchema.parse({
      reasoningMode: 'tokens',
      reasoningTokens: 4096,
      batchSize: 2,
    });
    const body = requestPayload(
      provider,
      'vendor/future-model',
      settings.policy,
      examples,
      settings,
    );
    expect(body).toMatchObject({
      reasoning: { max_tokens: 4096, exclude: true },
      max_tokens: 5096,
    });
    expect(body).not.toHaveProperty('provider');
    expect(
      fitExamples(
        env,
        'openrouter',
        'vendor/future-model',
        settings.policy,
        examples,
        Infinity,
        settings,
      ),
    ).toEqual(examples);
    const estimate = estimateTokens(
      env,
      'openrouter',
      'vendor/future-model',
      settings.policy,
      examples.slice(0, 1),
      settings,
    );
    expect(
      fitExamples(
        env,
        'openrouter',
        'vendor/future-model',
        settings.policy,
        examples,
        estimate - 1,
        settings,
      ),
    ).toEqual([]);
    expect(() =>
      requestPayload(provider, 'vendor/future-model', settings.policy, examples, {
        ...settings,
        maxOutputTokens: 4096,
      }),
    ).toThrow('room');
  });

  it('sends the selected effort and reserves the full total output cap', () => {
    const settings = settingsSchema.parse({
      reasoningMode: 'effort',
      reasoningTokens: 0,
      reasoningEffort: 'xhigh',
      maxOutputTokens: 16384,
      modelEndpoint: 'another-provider',
    });
    const body = requestPayload(
      provider,
      'vendor/effort-model',
      settings.policy,
      examples.slice(0, 1),
      settings,
    );
    expect(body).toMatchObject({
      reasoning: { effort: 'xhigh', exclude: true },
      max_tokens: 16384,
      provider: { only: ['another-provider'], allow_fallbacks: false },
    });
    expect(body).not.toHaveProperty('temperature');
    expect(
      estimateTokens(
        env,
        'openrouter',
        'vendor/effort-model',
        settings.policy,
        examples.slice(0, 1),
        settings,
      ),
    ).toBeGreaterThan(16384);
  });

  it('distinguishes the model default from explicitly disabling thinking', () => {
    const off = requestPayload(provider, 'vendor/model', defaultSettings.policy, examples, {
      ...defaultSettings,
      reasoningMode: 'off',
    });
    expect(off).toMatchObject({ reasoning: { enabled: false, exclude: true }, max_tokens: 1000 });
    const automatic = requestPayload(provider, 'vendor/model', defaultSettings.policy, examples, {
      ...defaultSettings,
      reasoningMode: 'default',
    });
    expect(automatic).toMatchObject({ reasoning: { exclude: true }, max_tokens: 8192 });
    expect(automatic).not.toHaveProperty('temperature');
    if (!('reasoning' in automatic)) throw new Error('Expected a chat payload');
    expect(automatic.reasoning).not.toHaveProperty('enabled');
  });

  it('requires declared compatibility for custom endpoints and never forwards OpenRouter routing to them', () => {
    const custom = { ...provider, id: 'custom', baseUrl: 'https://custom.example/v1' };
    const settings = settingsSchema.parse({
      reasoningMode: 'tokens',
      reasoningTokens: 2048,
      modelEndpoint: 'ignored-on-custom',
    });
    expect(() => requestPayload(custom, 'anything', settings.policy, examples, settings)).toThrow(
      'declared support',
    );
    const declared = {
      ...custom,
      reasoning: { supports_max_tokens: true, supported_efforts: ['low', 'high'] },
    };
    const body = requestPayload(declared, 'anything', settings.policy, examples, settings);
    expect(body).toMatchObject({
      reasoning: { max_tokens: 2048, exclude: true },
      max_tokens: 3048,
    });
    expect(body).not.toHaveProperty('provider');
    const configured = {
      ...env,
      MODEL_PROVIDERS_JSON: JSON.stringify([{ ...declared, apiKeyEnv: 'CUSTOM_KEY' }]),
    } as Env;
    expect(publicProviders(configured).find((p) => p.id === 'custom')?.reasoning).toEqual(
      declared.reasoning,
    );
    expect(
      requestPayload(
        { ...provider, format: 'decisions' },
        'cloudflare/clef',
        settings.policy,
        examples,
        settings,
      ),
    ).not.toHaveProperty('reasoning');
  });

  it('uses catalog effort choices, mandatory reasoning and explicit native-budget support without model-name lists', () => {
    expect(
      modelReasoningOptions({
        id: 'future/model',
        reasoning: {
          mandatory: true,
          supported_efforts: ['ultra', 'high', 'none'],
          default_effort: 'high',
        },
      }),
    ).toMatchObject({
      supported: true,
      mandatory: true,
      efforts: ['ultra', 'high'],
      tokens: false,
      defaultEffort: 'high',
    });
    expect(
      modelReasoningOptions({
        id: 'future/budget',
        supported_parameters: ['reasoning'],
        reasoning: { supports_max_tokens: true, supported_efforts: ['low'] },
      }),
    ).toMatchObject({ tokens: true, efforts: ['low'] });
    expect(
      modelReasoningOptions({ id: 'gateway-budget', reasoning: { mandatory: false } }).tokens,
    ).toBe(true);
    expect(
      modelReasoningOptions({ id: 'all-efforts', reasoning: { supported_efforts: null } }).efforts,
    ).toContain('minimal');
    expect(
      modelReasoningOptions({ id: 'no-reasoning', supported_parameters: ['temperature'] })
        .supported,
    ).toBe(false);
  });

  it('preserves the installed legacy profile and validates explicit settings', () => {
    const old = storedSettings(defaultSettings);
    expect(old).toEqual(defaultSettings);
    expect(thinkingMode(provider, old.model, old)).toBe('tokens');
    expect(thinkingMode(provider, 'different/model', old)).toBe('default');
    expect(
      settingsSchema.parse({ reasoningMode: 'effort', reasoningEffort: 'future-level' })
        .reasoningEffort,
    ).toBe('future-level');
    for (const invalid of [
      { reasoningMode: 'tokens', reasoningTokens: 0 },
      { reasoningMode: 'effort' },
      { reasoningMode: 'effort', reasoningEffort: 'none' },
      { reasoningMode: 'tokens', reasoningTokens: 4096, maxOutputTokens: 4096 },
    ])
      expect(() => settingsSchema.parse(invalid)).toThrow();
  });
});

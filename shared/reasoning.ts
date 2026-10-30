import type { ProviderPublic, Settings } from './types';

export const reasoningEfforts = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal'];
export interface ReasoningCapabilities {
  supported_efforts?: string[] | null;
  supports_max_tokens?: boolean;
  mandatory?: boolean;
  default_effort?: string;
}
export interface CatalogModel {
  id: string;
  supported_parameters?: string[];
  reasoning?: ReasoningCapabilities;
  top_provider?: { max_completion_tokens?: number | null };
}
export type ReasoningSettings = Pick<Settings, 'reasoningTokens'> &
  Partial<
    Pick<Settings, 'reasoningMode' | 'reasoningEffort' | 'maxOutputTokens' | 'modelEndpoint'>
  >;
type Route = Pick<ProviderPublic, 'baseUrl' | 'format' | 'reasoning'>;
export const isOpenRouter = (provider: Route) =>
  provider.baseUrl.replace(/\/$/, '') === 'https://openrouter.ai/api/v1';
export const supportsReasoningControls = (provider: Route) =>
  provider.format !== 'decisions' && (isOpenRouter(provider) || Boolean(provider.reasoning));

// Compatibility for already saved configurations and frozen, previously billed runs.
// Explicit controls below apply to any compatible model, without a model-name whitelist.
export function legacyThinking(provider: Route, model: string, settings: ReasoningSettings) {
  return settings.reasoningMode === undefined &&
    provider.format !== 'decisions' &&
    isOpenRouter(provider) &&
    model === 'google/gemini-2.5-flash-lite'
    ? settings.reasoningTokens || 0
    : 0;
}
export function thinkingMode(provider: Route, model: string, settings: ReasoningSettings) {
  return (
    settings.reasoningMode ?? (legacyThinking(provider, model, settings) ? 'tokens' : 'default')
  );
}
export function settingsForModel(settings: Settings, provider: string, model: string): Settings {
  if (settings.provider === provider && settings.model === model) return settings;
  return {
    ...settings,
    provider,
    model,
    ...(settings.reasoningMode === undefined
      ? {}
      : {
          reasoningMode: 'default',
          reasoningTokens: 0,
          reasoningEffort: undefined,
          maxOutputTokens: undefined,
          modelEndpoint: undefined,
        }),
  };
}
export function modelReasoningOptions(model?: CatalogModel, declared?: ReasoningCapabilities) {
  const info = declared ?? model?.reasoning;
  const supported = Boolean(info) || model?.supported_parameters?.includes('reasoning') === true;
  const efforts =
    info?.supported_efforts === null
      ? reasoningEfforts
      : Array.isArray(info?.supported_efforts)
        ? info.supported_efforts
        : [];
  return {
    supported,
    mandatory: info?.mandatory === true,
    efforts: efforts.filter(
      (effort) => effort !== 'none' && /^[a-z][a-z0-9_-]{0,39}$/.test(effort),
    ),
    // Some catalog entries omit the native token-budget flag. The gateway accepts
    // max_tokens for these reasoning models and maps it to effort when necessary.
    tokens:
      supported &&
      (info?.supports_max_tokens === true ||
        (info?.supports_max_tokens !== false && !efforts.length)),
    defaultEffort:
      info?.default_effort && info.default_effort !== 'none' ? info.default_effort : undefined,
    maxOutputTokens: model?.top_provider?.max_completion_tokens ?? undefined,
  };
}

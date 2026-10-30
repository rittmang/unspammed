import { useEffect, useState } from 'react';
import type { ProviderPublic, Settings } from '../shared/types';
import {
  isOpenRouter,
  legacyThinking,
  modelReasoningOptions,
  supportsReasoningControls,
  thinkingMode,
  type CatalogModel,
} from '../shared/reasoning';
import { apiForGroup } from './api';

export function ThinkingControls({
  settings,
  provider,
  api,
  change,
}: {
  settings: Settings;
  provider?: ProviderPublic;
  api: ReturnType<typeof apiForGroup>;
  change: (settings: Settings) => void;
}) {
  const [catalog, setCatalog] = useState<{ provider: string; models: CatalogModel[] }>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const router = provider && provider.format !== 'decisions' && isOpenRouter(provider);
  useEffect(() => {
    setError('');
    if (!router || !provider) return;
    const controller = new AbortController();
    void api<{ data: CatalogModel[] }>(
      `/model-catalog?provider=${encodeURIComponent(provider.id)}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!Array.isArray(result.data)) throw new Error('The model catalog was incomplete.');
        if (!controller.signal.aborted) setCatalog({ provider: provider.id, models: result.data });
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [api, router, provider?.id, attempt]);
  if (!provider) return null;
  const model =
    catalog?.provider === provider.id
      ? catalog.models.find((m) => m.id === settings.model)
      : undefined;
  const options = modelReasoningOptions(model, provider.reasoning);
  const legacy = legacyThinking(provider, settings.model, settings);
  const mode = thinkingMode(provider, settings.model, settings);
  const compatible = supportsReasoningControls(provider);
  const loading = router && catalog?.provider !== provider.id && !error;
  const supported = compatible && (options.supported || Boolean(legacy));
  const tokenOption = options.tokens || Boolean(legacy);
  const set = (patch: Partial<Settings>) =>
    change({
      ...settings,
      reasoningMode: mode,
      ...(legacy ? { modelEndpoint: 'google-ai-studio' } : {}),
      ...patch,
    });
  return (
    <>
      <label className="field">
        Thinking
        <select
          aria-label="Thinking"
          value={mode}
          disabled={!supported || Boolean(loading && !legacy)}
          onChange={(event) => {
            const next = event.target.value as Settings['reasoningMode'];
            set({
              reasoningMode: next,
              reasoningTokens: next === 'tokens' ? settings.reasoningTokens || 1024 : 0,
              reasoningEffort:
                next === 'effort'
                  ? options.efforts.includes(options.defaultEffort || '')
                    ? options.defaultEffort
                    : options.efforts[0]
                  : undefined,
              maxOutputTokens:
                next === 'effort' ? Math.min(options.maxOutputTokens || 16384, 16384) : undefined,
            });
          }}
        >
          <option value="default">Model default</option>
          {(!options.mandatory || mode === 'off') && (
            <option value="off" disabled={options.mandatory}>
              Off
            </option>
          )}
          {(tokenOption || mode === 'tokens') && (
            <option value="tokens" disabled={!tokenOption}>
              Token budget
            </option>
          )}
          {(options.efforts.length > 0 || mode === 'effort') && (
            <option value="effort" disabled={!options.efforts.length}>
              Effort level
            </option>
          )}
        </select>
        <small>
          {loading
            ? 'Loading the model’s thinking options…'
            : error
              ? 'Model options could not be loaded. Your saved settings are preserved.'
              : !compatible
                ? 'This endpoint does not advertise thinking controls.'
                : !supported
                  ? 'No thinking controls are advertised for this model.'
                  : options.mandatory
                    ? 'This model requires thinking. Choose its default or a supported setting.'
                    : 'Options follow the selected model. Thinking counts toward output usage.'}
        </small>
      </label>
      {error && (
        <div className="field">
          <p className="field-help" role="alert">
            {error}
          </p>
          <button
            type="button"
            className="button secondary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Reload model options
          </button>
        </div>
      )}
      {mode === 'tokens' && (
        <label className="field">
          Thinking token budget
          <input
            aria-label="Thinking token budget"
            type="number"
            required
            min="1"
            max="65536"
            step="1"
            value={settings.reasoningTokens}
            onChange={(event) =>
              set({ reasoningTokens: Number(event.target.value), maxOutputTokens: undefined })
            }
          />
          <small>
            Choose the model’s supported budget. The gateway may map this to effort when a native
            budget is unavailable. Classification output gets additional room.
          </small>
        </label>
      )}
      {mode === 'effort' && (
        <label className="field">
          Thinking effort
          <select
            aria-label="Thinking effort"
            required
            value={settings.reasoningEffort || ''}
            onChange={(event) => set({ reasoningEffort: event.target.value })}
          >
            {!options.efforts.includes(settings.reasoningEffort || '') && (
              <option value={settings.reasoningEffort || ''}>
                {settings.reasoningEffort || 'Choose effort'}
              </option>
            )}
            {options.efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
          <small>Effort values are advertised by the selected model.</small>
        </label>
      )}
      {compatible && mode !== 'off' && (
        <label className="field">
          Total output token limit
          <input
            aria-label="Total output token limit"
            type="number"
            min={
              mode === 'tokens'
                ? settings.reasoningTokens + Math.max(1000, settings.batchSize * 160)
                : 1000
            }
            max={Math.min(options.maxOutputTokens || 262144, 262144)}
            step="1"
            value={
              settings.maxOutputTokens ??
              (mode === 'tokens'
                ? settings.reasoningTokens + Math.max(1000, settings.batchSize * 160)
                : mode === 'effort'
                  ? 9192
                  : settings.reasoningMode
                    ? 8192
                    : Math.max(1000, settings.batchSize * 160))
            }
            onChange={(event) => set({ maxOutputTokens: Number(event.target.value) })}
          />
          <small>
            Includes thinking and the classification result. A higher cap reserves more of the daily
            allowance; actual reported usage is charged.
          </small>
        </label>
      )}
      {router && (
        <label className="field">
          Upstream provider (optional)
          <input
            aria-label="Upstream provider (optional)"
            value={settings.modelEndpoint ?? (legacy ? 'google-ai-studio' : '')}
            placeholder="Automatic routing"
            onChange={(event) => set({ modelEndpoint: event.target.value || undefined })}
          />
          <small>
            A provider slug pins the route and disables fallback. Leave empty for automatic routing.
          </small>
        </label>
      )}
    </>
  );
}

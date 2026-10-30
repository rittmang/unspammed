import { afterEach, describe, expect, it, vi } from 'vitest';
import { classify } from '../worker/classifier';
import type { Env } from '../worker/env';
import { providerError, rateLimitRetry, retryAfterDelay } from '../worker/provider-errors';
import { defaultSettings } from '../shared/types';

const env = {
  OPENROUTER_API_KEY: 'private-provider-key',
  BROWSER_AUTH_TOKEN: 'private-browser-token',
} as Env;
afterEach(() => vi.unstubAllGlobals());

describe('provider failures and durable retry deadlines', () => {
  it('honors seconds and HTTP dates and uses bounded exponential backoff with jitter', async () => {
    const now = Date.parse('2026-10-24T00:00:00Z');
    expect(retryAfterDelay('120', now)).toBe(120000);
    expect(retryAfterDelay('Sat, 24 Oct 2026 00:03:00 GMT', now)).toBe(180000);
    expect(retryAfterDelay('invalid', now)).toBeNull();
    expect(retryAfterDelay('-1', now)).toBeNull();
    const error = await providerError(
      new Response('upstream rate limit', { status: 429, headers: { 'Retry-After': '120' } }),
      env,
      'Model provider',
    );
    expect(rateLimitRetry(error, 0, now, () => 0)).toEqual({ attempts: 1, nextAt: now + 120000 });
    const noHeader = await providerError(
      new Response('upstream rate limit', { status: 429 }),
      env,
      'Model provider',
    );
    expect(rateLimitRetry(noHeader, 0, now, () => 0)?.nextAt).toBe(now + 30000);
    expect(rateLimitRetry(noHeader, 1, now, () => 0)?.nextAt).toBe(now + 60000);
    expect(rateLimitRetry(noHeader, 25, now, () => 1)?.nextAt).toBe(now + 900000);
  });

  it('retains raw upstream diagnostics and request/retry headers while redacting credentials', async () => {
    const raw = 'Detailed upstream quota cause '.repeat(25) + 'end-of-provider-diagnostic';
    const body = JSON.stringify({
      error: {
        code: 429,
        message: 'Rate limit exceeded',
        metadata: {
          raw,
          provider_name: 'Google AI Studio',
          authorization: 'Bearer private-provider-key',
          token: 'unknown-provider-token',
          echo: 'private-browser-token',
        },
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(body, {
            status: 429,
            headers: { 'Retry-After': '90', 'X-Request-ID': 'req-diagnostic' },
          }),
      ),
    );
    const error = await classify(env, 'openrouter', defaultSettings.model, defaultSettings.policy, [
      { id: 'one', text: 'A harmless question', label: 'ham' },
    ]).catch((e) => e);
    expect(error.message).toContain(raw);
    expect(error.message).toContain('req-diagnostic');
    expect(error.message).toContain('Retry-After=90');
    expect(error.message).not.toContain('private-provider-key');
    expect(error.message).not.toContain('private-browser-token');
    expect(error.message).not.toContain('unknown-provider-token');
    expect(error.usage).toMatchObject({ rejected: true, input: 0, output: 0, cost: 0 });
    expect(rateLimitRetry(error)?.attempts).toBe(1);
  });

  it.each([401, 402, 403, 500, 503])(
    'preserves HTTP %s details without automatically replaying uncertain work',
    async (status) => {
      const error = await providerError(
        new Response('Exact provider diagnostic', { status }),
        env,
        'Policy drafting provider',
      );
      expect(error.message).toContain('Exact provider diagnostic');
      expect(error.rejected).toBe(false);
      expect(rateLimitRetry(error)).toBeNull();
    },
  );

  it('does not treat a generation carrying usage as an unbilled rate-limit rejection', async () => {
    const error = await providerError(
      Response.json(
        { id: 'possibly-billed', usage: { prompt_tokens: 10 }, error: { code: 429 } },
        { status: 429 },
      ),
      env,
      'Model provider',
    );
    expect(rateLimitRetry(error)).toBeNull();
  });

  it('bounds oversized responses and marks the diagnostic as truncated', async () => {
    const error = await providerError(
      new Response('x'.repeat(100000), { status: 429 }),
      env,
      'Model provider',
    );
    expect(error.message.length).toBeLessThanOrEqual(65536);
    expect(error.rejected).toBe(false);
  });
});

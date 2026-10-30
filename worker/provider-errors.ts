import type { Env } from './env';

const MAX_ERROR_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 60 * 1024;

// Keep provider diagnostics intact except credentials, even when an upstream echoes them.
export function errorText(error: unknown, env: Env) {
  let text = error instanceof Error ? error.message : String(error);
  let customKeys: string[] = [];
  try {
    customKeys = JSON.parse(env.MODEL_PROVIDERS_JSON || '[]')
      .map((p: { apiKeyEnv?: string }) => p.apiKeyEnv)
      .filter(Boolean);
  } catch {
    /* Configuration errors must still be loggable. */
  }
  const secrets = Object.entries(env)
    .filter(
      ([key, value]) =>
        (/TOKEN|SECRET|PASSWORD|KEY|DATABASE.*URL|API_HASH/i.test(key) ||
          customKeys.includes(key)) &&
        typeof value === 'string' &&
        value.length >= 4,
    )
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) {
    for (const variant of new Set([
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
    ]))
      text = text.split(variant).join('[REDACTED]');
  }
  return text
    .replace(/Bearer\s+[^\s"'<>\\]+/gi, 'Bearer [REDACTED]')
    .replace(
      /("(?:api[_-]?key|access[_-]?token|token|secret|password|authorization|cookie|set-cookie)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
      '$1"[REDACTED]"',
    )
    .replace(/(https?:\/\/|postgres(?:ql)?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .slice(0, MAX_ERROR_BYTES);
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly rejected: boolean,
    readonly retryAfter: number | null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function retryAfterDelay(value: string | null, now = Date.now()) {
  if (!value?.trim()) return null;
  const header = value.trim();
  if (header.startsWith('-')) return null;
  if (/^\d+(?:\.\d+)?$/.test(header)) {
    const delay = Number(header) * 1000;
    return Number.isFinite(delay) ? delay : null;
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export async function providerError(response: Response, env: Env, label: string) {
  const reader = response.body?.getReader();
  let body = '',
    bytes = 0,
    truncated = false;
  const decoder = new TextDecoder();
  if (reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const remaining = MAX_BODY_BYTES - bytes;
        body += decoder.decode(value.subarray(0, remaining), { stream: true });
        bytes += value.length;
        if (bytes > MAX_BODY_BYTES) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
      body += decoder.decode();
    } catch {
      body += ' [error response could not be fully read]';
      truncated = true;
    }
  }
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    /* Text/HTML errors are still useful diagnostics. */
  }
  // Only a pre-generation rate-limit rejection is safe to retry without risking paid work.
  const rejected =
    response.status === 429 &&
    !truncated &&
    !data?.id &&
    !data?.usage &&
    !data?.choices &&
    !data?.answers;
  const requestId = response.headers.get('x-request-id') || response.headers.get('cf-ray');
  const retryAfter = response.headers.get('retry-after');
  const headers = [
    requestId && `request-id=${requestId}`,
    retryAfter && `Retry-After=${retryAfter}`,
  ]
    .filter(Boolean)
    .join('; ');
  return new ProviderError(
    errorText(
      `${label} returned HTTP ${response.status}.${headers ? ` ${headers}.` : ''}${body ? `\n${body}` : ''}${truncated ? '\n[provider error body truncated at 60 KiB]' : ''}`,
      env,
    ),
    response.status,
    rejected,
    retryAfterDelay(retryAfter),
  );
}

// No sleep inside a request: callers persist this deadline with the existing job cursor.
export function rateLimitRetry(
  error: unknown,
  previousAttempts = 0,
  now = Date.now(),
  random = Math.random,
) {
  const failure =
    error instanceof ProviderError ? error : error instanceof Error ? error.cause : null;
  if (!(failure instanceof ProviderError) || failure.status !== 429 || !failure.rejected)
    return null;
  const attempts = Math.min(previousAttempts + 1, 30);
  const backoff = Math.min(15 * 60_000, 60_000 * 2 ** Math.min(attempts - 1, 4));
  const delay = Math.max(failure.retryAfter ?? 0, backoff / 2 + (random() * backoff) / 2);
  return { attempts, nextAt: Math.min(8.64e15, now + Math.ceil(delay)) };
}

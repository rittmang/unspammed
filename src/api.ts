import { isMiniApp, telegramApp } from './mini-app';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs = 0,
  ) {
    super(message);
  }
}
let selectedGroup = '';
export function setApiGroup(chatId: string) {
  selectedGroup = chatId;
}
export function apiForGroup(chatId: string) {
  const route = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), 'x-watchtower-group': chatId },
  });
  const call = <T>(path: string, init?: RequestInit) => api<T>(path, route(init));
  return Object.assign(call, {
    retry: <T>(path: string, init: RequestInit, signal?: AbortSignal) =>
      retryApi<T>(path, route(init), signal),
  });
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Capture the group before starting: retries and pending writes keep their original
  // destination even if the owner switches workspaces while the request is running.
  init = {
    ...init,
    headers: {
      ...(selectedGroup && !/^\/groups(?:\/|$)/.test(path)
        ? { 'x-watchtower-group': selectedGroup }
        : {}),
      ...Object.fromEntries(new Headers(init.headers)),
    },
  };
  const read = ['GET', 'HEAD'].includes((init.method || 'GET').toUpperCase());
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestApi<T>(path, init);
    } catch (e) {
      if (
        !read ||
        init.signal?.aborted ||
        attempt >= 2 ||
        (e instanceof ApiError && e.retryAfterMs > 5000) ||
        !(
          e instanceof TypeError ||
          (e instanceof ApiError && (e.status >= 500 || e.status === 429))
        )
      )
        throw e;
      await waitForRetry(
        Math.max(500 * 2 ** attempt, e instanceof ApiError ? e.retryAfterMs : 0),
        init.signal,
      );
    }
  }
}
async function requestApi<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetchApi(path, init);
  if (response.status === 401) {
    if (!isMiniApp && typeof window !== 'undefined')
      window.dispatchEvent?.(new Event('watchtower:unauthorized'));
    throw new ApiError(
      isMiniApp
        ? 'Close and reopen the Mini App from the bot to sign in.'
        : 'Your owner session has expired. Sign in again from the dashboard sign-in page.',
      response.status,
    );
  }
  let data: T & { error?: string };
  const body = await response.text();
  try {
    data = JSON.parse(body);
  } catch {
    throw new ApiError(
      /(?:error\s*(?:code:\s*)?1102|Worker exceeded (?:CPU time|resource) limit)/i.test(body)
        ? 'Cloudflare Worker reached its CPU limit. Please retry shortly; this does not indicate missing saved data.'
        : `The dashboard could not load this request (${response.status}). Please retry shortly.`,
      response.status,
      (Number(response.headers.get('Retry-After')) || 0) * 1000,
    );
  }
  if (!response.ok) {
    const quota = /Exceeded allowed rows (?:read|written) in Durable Objects free tier/i.test(
      data.error || '',
    );
    throw new ApiError(
      quota
        ? 'Cloudflare’s daily database quota is exhausted. Database reads and moderation are unavailable until the quota resets at midnight UTC or the Workers plan is upgraded.'
        : data.error || `Request failed (${response.status}).`,
      response.status,
      Math.max(quota ? 300_000 : 0, (Number(response.headers.get('Retry-After')) || 0) * 1000),
    );
  }
  return data as T;
}
export function fetchApi(path: string, init: RequestInit = {}) {
  const prefix = `${isMiniApp ? '/mini' : ''}/api`;
  const target = `${prefix}${path}`;
  const pathname = new URL(target, 'https://watchtower.invalid').pathname;
  if (!path.startsWith('/') || !pathname.startsWith(`${prefix}/`))
    throw new Error('Invalid dashboard API path.');
  return fetch(target, {
    ...init,
    ...(isMiniApp ? { credentials: 'omit', redirect: 'error' } : {}),
    headers: {
      'Content-Type': 'application/json',
      'X-Watchtower-Request': '1',
      ...Object.fromEntries(new Headers(init.headers)),
      ...(isMiniApp ? { 'X-Telegram-Init-Data': telegramApp?.initData || '' } : {}),
    },
  });
}
function waitForRetry(delay: number, signal?: AbortSignal | null) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delay);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export function download(name: string, value: unknown) {
  return downloadBlob(
    name,
    new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
  );
}
export async function downloadBlob(name: string, blob: Blob) {
  if (isMiniApp) {
    if (blob.size > 20_000_000)
      throw new Error(
        'Telegram exports are limited to 20 MB. Choose Open in browser for larger exports.',
      );
    await api('/telegram-export', {
      method: 'POST',
      headers: { 'X-Watchtower-File-Name': name },
      body: blob,
    });
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function retryApi<T>(
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await api<T>(path, { ...init, signal });
    } catch (e) {
      if (
        signal?.aborted ||
        (e instanceof ApiError && e.retryAfterMs > 60_000) ||
        attempt >= 2 ||
        !(
          e instanceof TypeError ||
          (e instanceof ApiError && (e.status >= 500 || e.status === 429)) ||
          (e instanceof Error &&
            /Request failed \(5\d\d\)|Could not persist|instance.*(?:replaced|reset)|overloaded|temporarily unavailable/i.test(
              e.message,
            ))
        )
      )
        throw e;
      await waitForRetry(500 * 2 ** attempt, signal);
    }
  }
}

import { createHmac } from 'node:crypto';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizeMiniApp, MINI_APP_MAX_AGE } from '../worker/mini-app';
import { createWorker } from '../worker/index';
import { readBody } from '../worker/http';
import type { Env } from '../worker/env';
import type { Directory } from '../worker/directory';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// Node's implementation independently signs the payload verified with Workers Web Crypto.
function launch(fields: Record<string, string> = {}, token = env.TELEGRAM_BOT_TOKEN!) {
  const params = new URLSearchParams({
    query_id: 'independent-test-query',
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: Number(env.OWNER_TELEGRAM_ID), first_name: 'Owner' }),
    ...fields,
  });
  const data = [...params]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const key = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', key).update(data).digest('hex'));
  return params.toString();
}
function request(path = '/mini/api/overview', data?: string, init: RequestInit = {}) {
  return new Request(`https://mini.example${path}`, {
    ...init,
    headers: {
      ...(data ? { 'X-Telegram-Init-Data': data } : {}),
      ...Object.fromEntries(new Headers(init.headers)),
    },
  });
}
function app() {
  const service = vi.fn(async (r: Request) =>
    Response.json({ path: new URL(r.url).pathname, group: r.headers.get('X-Watchtower-Group') }),
  );
  const directory = {
    session: async (fn: () => Promise<unknown>) => fn(),
    get: async (id: string) =>
      id === env.TELEGRAM_CHAT_ID ? { provisioned: 1, status: 'active' } : null,
    fetch: async () => Response.json({ groups: [] }),
  } as unknown as Directory;
  const assets = vi.fn(
    async () =>
      new Response(
        '<!doctype html><html><head><script src="/theme.js"></script><link href="/assets/index.css" rel="stylesheet"></head><body><script type="module" src="/assets/index.js"></script></body></html>',
        { headers: { 'Content-Type': 'text/html' } },
      ),
  );
  const config = {
    ...env,
    DEV_MODE: 'false',
    ACCESS_TEAM_DOMAIN: 'https://example.cloudflareaccess.com',
    ACCESS_AUD: 'test-audience',
    ASSETS: { fetch: assets },
    TELEGRAM_BOT_USERNAME: 'testbot',
    DASHBOARD_URL: 'https://dashboard.example',
  } as unknown as Env;
  return {
    worker: createWorker(
      () => ({ fetch: service }),
      () => directory,
    ),
    config,
    service,
    assets,
  };
}

describe('Telegram owner authentication', () => {
  it('accepts a fresh, independently signed owner payload, including optional signed fields', async () => {
    expect(
      await authorizeMiniApp(
        request(undefined, launch({ signature: 'optional-signature', start_param: 'lab' })),
        env,
      ),
    ).toBe(`telegram:${env.OWNER_TELEGRAM_ID}`);
  });
  it.each([
    ['missing', () => ''],
    ['tampered user', () => launch().replace('Owner', 'Attacker')],
    ['different bot', () => launch({}, 'wrong-bot-token')],
    [
      'expired',
      () => launch({ auth_date: String(Math.floor(Date.now() / 1000) - MINI_APP_MAX_AGE - 1) }),
    ],
    ['future', () => launch({ auth_date: String(Math.floor(Date.now() / 1000) + 31) })],
    ['duplicate field', () => `${launch()}&user=%7B%22id%22%3A999%7D`],
    ['duplicate hash', () => `${launch()}&hash=${'0'.repeat(64)}`],
    ['malformed user', () => launch({ user: '{' })],
    ['string identity', () => launch({ user: '{"id":"999"}' })],
    ['unsafe integer', () => launch({ user: '{"id":9007199254740992}' })],
    ['bot identity', () => launch({ user: '{"id":999,"is_bot":true}' })],
    ['oversized', () => 'x'.repeat(8193)],
    ['ambiguous lines', () => launch({ start_param: 'a\nuser=b' })],
  ])('rejects %s without returning credentials', async (_name, data) => {
    const raw = data();
    await expect(authorizeMiniApp(request(undefined, raw), env)).rejects.toMatchObject({
      status: 401,
    });
  });
  it('rejects a valid signed non-owner and fails closed for missing configuration', async () => {
    await expect(
      authorizeMiniApp(request(undefined, launch({ user: '{"id":42}' })), env),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      authorizeMiniApp(request(undefined, launch()), { ...env, TELEGRAM_BOT_TOKEN: '' }),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe('Mini App routing and private data', () => {
  it('serves only the static shell without authentication and scopes SDK/frame permissions to it', async () => {
    const { worker, config, assets } = app();
    const shell = await worker.fetch(request('/mini/'), config);
    expect(shell.status).toBe(200);
    const html = await shell.text();
    expect(new URL((assets.mock.calls[0] as unknown as [Request])[0].url).pathname).toBe('/');
    expect(html).toContain('data-mini-app="true"');
    expect(html).toContain('data-bot-username="testbot"');
    expect(html).toContain('data-dashboard-url="https://dashboard.example/"');
    expect(html).toContain('https://telegram.org/js/telegram-web-app.js?64');
    expect(html).toContain('/mini/assets/index.js');
    expect(html).toContain('/mini/theme.js');
    expect(shell.headers.get('Content-Security-Policy')).toContain(
      'frame-ancestors https://web.telegram.org;',
    );
    expect(shell.headers.get('X-Frame-Options')).toBeNull();
    expect(shell.headers.get('Cache-Control')).toBe('no-store');
    expect((await worker.fetch(request('/mini'), config)).headers.get('Location')).toBe(
      'https://mini.example/mini/',
    );
    assets.mockClear();
    for (const path of ['/mini/.dev.vars', '/mini/unknown', '/mini/assets/index.js.map']) {
      expect((await worker.fetch(request(path), config)).status).toBe(
        path.startsWith('/mini/') ? 404 : 401,
      );
    }
    expect(assets).not.toHaveBeenCalled();
    expect((await worker.fetch(request('/mini/assets/unlisted.js'), config)).status).toBe(404);
    expect(assets).not.toHaveBeenCalled();
    expect((await worker.fetch(request('/mini/assets/index.js'), config)).status).toBe(200);
    for (const path of ['/', '/login', '/assets/index.js'])
      expect((await worker.fetch(request(path), config)).status).toBe(200);
  });
  it('never treats a public shell, a claimed ID, a browser cookie, or local DEV_MODE as Mini App authentication', async () => {
    const { worker, config, service } = app();
    for (const url of [
      'https://mini.example/mini/api/overview',
      'http://127.0.0.1/mini/api/overview',
    ]) {
      const response = await worker.fetch(
        new Request(url, {
          headers: {
            Cookie: 'owner=999',
            'X-Telegram-User-Id': '999',
            'Cf-Access-Jwt-Assertion': 'unverified',
          },
        }),
        { ...config, DEV_MODE: 'true' },
      );
      expect(response.status).toBe(401);
    }
    expect(service).not.toHaveBeenCalled();
    expect((await worker.fetch(request('/api/overview', launch()), config)).status).toBe(401);
  });
  it('routes signed reads, writes and images through existing group isolation and mutation protection', async () => {
    const { worker, config, service } = app();
    const data = launch();
    const response = await worker.fetch(request(undefined, data), config);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      owner: `telegram:${env.OWNER_TELEGRAM_ID}`,
      path: '/api/overview',
      dev: false,
    });
    const write = (headers = {}) =>
      request('/mini/api/settings', data, { method: 'PUT', body: '{}', headers });
    expect((await worker.fetch(write(), config)).status).toBe(403);
    expect(
      (
        await worker.fetch(
          write({ 'X-Watchtower-Request': '1', Origin: 'https://evil.example' }),
          config,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await worker.fetch(
          write({ 'X-Watchtower-Request': '1', Origin: 'https://mini.example' }),
          config,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await worker.fetch(
          request('/mini/api/overview', data, {
            headers: { 'X-Watchtower-Group': '-10099999999' },
          }),
          config,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await worker.fetch(
          request(`/mini/api/messages/1/image?group=${env.TELEGRAM_CHAT_ID}`, data),
          config,
        )
      ).status,
    ).toBe(200);
    expect(new URL(service.mock.calls.at(-1)![0].url).pathname).toBe('/api/messages/1/image');
  });
  it('delivers exports only to the configured owner, once, and hides provider errors', async () => {
    const { worker, config } = app();
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    const file = JSON.stringify({
      version: 1,
      examples: [{ text: 'Private example' }],
      chat_id: 'attacker',
    });
    const headers = {
      'X-Watchtower-Request': '1',
      'X-Watchtower-File-Name': 'watchtower-dataset.json',
      Origin: 'https://mini.example',
    };
    const upload = (data = launch(), more = {}) =>
      request('/mini/api/telegram-export', data, {
        method: 'POST',
        body: file,
        headers: { ...headers, ...more },
      });
    expect((await worker.fetch(upload('forged'), config)).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    expect((await worker.fetch(upload(), config)).status).toBe(200);
    const form = fetch.mock.calls[0][1].body as FormData;
    expect(form.get('chat_id')).toBe(env.OWNER_TELEGRAM_ID);
    expect(await (form.get('document') as File).text()).toBe(file);
    expect(fetch).toHaveBeenCalledOnce();
    expect(
      (await worker.fetch(upload(launch(), { 'Content-Length': '20000001' }), config)).status,
    ).toBe(413);
    expect(
      (await worker.fetch(upload(launch(), { 'X-Watchtower-File-Name': '../secret' }), config))
        .status,
    ).toBe(400);
    fetch.mockResolvedValueOnce(
      Response.json({ ok: false, description: `token=${env.TELEGRAM_BOT_TOKEN}` }, { status: 400 }),
    );
    const failed = await worker.fetch(upload(), config);
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain(env.TELEGRAM_BOT_TOKEN);
  });
  it('bounds actual streamed export bytes even when Content-Length is absent', async () => {
    const bytes = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(3));
        c.enqueue(new Uint8Array(3));
        c.close();
      },
    });
    await expect(
      readBody(new Request('https://mini.example', { method: 'POST', body: bytes }), 5),
    ).rejects.toMatchObject({ status: 413 });
  });
});

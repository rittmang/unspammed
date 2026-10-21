import { createHash, createHmac, randomBytes } from 'node:crypto';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authRoute, authorize, BROWSER_SESSION_SECONDS } from '../worker/auth';
import { htmlShell } from '../worker/html-shell';
import type { Env } from '../worker/env';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const config = {
  ...env,
  DEV_MODE: 'false',
  BROWSER_AUTH_TOKEN: randomBytes(32).toString('base64url'),
  ACCESS_AUD: '',
  ACCESS_TEAM_DOMAIN: '',
  ADMIN_EMAIL: '',
} as Env;
const request = (path: string, init: RequestInit = {}) =>
  new Request(`https://dashboard.example${path}`, init);
const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://dashboard.example',
      'X-Watchtower-Request': '1',
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function login() {
  const response = (await authRoute(
    post('/api/auth/login', { token: config.BROWSER_AUTH_TOKEN }),
    config,
  ))!;
  return { response, cookie: response.headers.get('Set-Cookie')!.split(';')[0] };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('portable owner browser authentication', () => {
  it('exchanges the secret for an independent signed cookie and never echoes it', async () => {
    const { response, cookie } = await login();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    const value = response.headers.get('Set-Cookie')!;
    for (const flag of [
      '__Host-watchtower_session=',
      'HttpOnly',
      'Secure',
      'SameSite=Strict',
      'Path=/',
      `Max-Age=${BROWSER_SESSION_SECONDS}`,
    ])
      expect(value).toContain(flag);
    expect(value).not.toContain(config.BROWSER_AUTH_TOKEN);
    expect(await authorize(request('/api/overview', { headers: { Cookie: cookie } }), config)).toBe(
      'browser-owner',
    );
    const status = await authRoute(
      request('/api/auth/status', { headers: { Cookie: cookie } }),
      config,
    );
    expect(await status!.json()).toMatchObject({
      authenticated: true,
      browserToken: true,
      cloudflareAccess: false,
    });
  });
  it('requires same-origin protected HTTPS login and returns generic invalid-token errors', async () => {
    const invalidHeaders: Record<string, string>[] = [
      { Origin: '' },
      { Origin: 'https://evil.example' },
      { 'X-Watchtower-Request': '' },
    ];
    for (const headers of invalidHeaders) {
      await expect(
        authRoute(post('/api/auth/login', { token: config.BROWSER_AUTH_TOKEN }, headers), config),
      ).rejects.toMatchObject({ status: 403 });
    }
    await expect(
      authRoute(
        new Request('http://dashboard.example/api/auth/login', {
          method: 'POST',
          headers: {
            Origin: 'http://dashboard.example',
            'X-Watchtower-Request': '1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ token: config.BROWSER_AUTH_TOKEN }),
        }),
        config,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      authRoute(post('/api/auth/login', { token: 'incorrect' }), config),
    ).rejects.toMatchObject({ status: 401, message: 'The sign-in token is incorrect.' });
    await expect(
      authRoute(post('/api/auth/login', { token: config.BROWSER_AUTH_TOKEN }), {
        ...config,
        BROWSER_AUTH_TOKEN: 'weak',
      }),
    ).rejects.toMatchObject({ status: 503 });
  });
  it('rejects altered, duplicate, expired and revoked sessions; cookies cannot bypass write protection', async () => {
    const { cookie } = await login();
    for (const value of [cookie.replace('v1.', 'v2.'), `${cookie}; ${cookie}`, `${cookie}x`]) {
      await expect(
        authorize(request('/api/overview', { headers: { Cookie: value } }), config),
      ).rejects.toMatchObject({ status: 401 });
    }
    await expect(
      authorize(request('/api/overview', { headers: { Cookie: cookie } }), {
        ...config,
        BROWSER_AUTH_TOKEN: randomBytes(32).toString('base64url'),
      }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      authorize(post('/api/settings', {}, { Cookie: cookie, Origin: '' }), config),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      authorize(
        post('/api/settings', {}, { Cookie: cookie, Origin: 'https://evil.example' }),
        config,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      authorize(post('/api/settings', {}, { Cookie: cookie, 'X-Watchtower-Request': '' }), config),
    ).rejects.toMatchObject({ status: 403 });
    expect(await authorize(post('/api/settings', {}, { Cookie: cookie }), config)).toBe(
      'browser-owner',
    );
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + BROWSER_SESSION_SECONDS * 1000 + 1000);
    await expect(
      authorize(request('/api/overview', { headers: { Cookie: cookie } }), config),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('rejects independently signed sessions with future issue dates or extended lifetimes', async () => {
    const now = Math.floor(Date.now() / 1000);
    const key = createHash('sha256')
      .update(`watchtower:browser-session:v1\u0000${config.BROWSER_AUTH_TOKEN}`)
      .digest();
    for (const [issued, expires] of [
      [now + 31, now + 31 + BROWSER_SESSION_SECONDS],
      [now, now + BROWSER_SESSION_SECONDS + 1],
    ]) {
      const value = `v1.${issued}.${expires}.${randomBytes(16).toString('base64url')}`;
      const signature = createHmac('sha256', key).update(value).digest('base64url');
      await expect(
        authorize(
          request('/api/overview', {
            headers: { Cookie: `__Host-watchtower_session=${value}.${signature}` },
          }),
          config,
        ),
      ).rejects.toMatchObject({ status: 401 });
    }
  });
  it('clears the browser cookie on protected sign-out and permits Telegram-only configuration', async () => {
    const response = (await authRoute(post('/api/auth/logout'), config))!;
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
    const minimal = { ...config, BROWSER_AUTH_TOKEN: '', TELEGRAM_BOT_USERNAME: 'example_bot' };
    const status = (await authRoute(request('/api/auth/status'), minimal))!;
    const data = await status.json();
    expect(data).toMatchObject({
      authenticated: false,
      telegram: true,
      browserToken: false,
      cloudflareAccess: false,
    });
    expect(JSON.stringify(data)).not.toContain(minimal.TELEGRAM_BOT_TOKEN);
    await expect(authorize(request('/api/overview'), minimal)).rejects.toMatchObject({
      status: 401,
    });
  });
  it('retains optional Access with required expiry, issuer, audience, signature and exact owner', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const key = { ...(await exportJWK(publicKey)), kid: 'portable-access', alg: 'RS256' };
    const fetch = vi.fn(async () => Response.json({ keys: [key] }));
    vi.stubGlobal('fetch', fetch);
    const options = {
      ...config,
      ACCESS_TEAM_DOMAIN: 'https://portable-auth-test.cloudflareaccess.com',
      ACCESS_AUD: 'portable-audience',
      ADMIN_EMAIL: 'owner@example.com',
    };
    const claims = {
      email: 'owner@example.com',
      iss: options.ACCESS_TEAM_DOMAIN,
      aud: options.ACCESS_AUD,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const token = (changes = {}) =>
      new SignJWT({ ...claims, ...changes })
        .setProtectedHeader({ alg: 'RS256', kid: key.kid })
        .sign(privateKey);
    const access = (assertion: string) =>
      request('/api/overview', { headers: { 'Cf-Access-Jwt-Assertion': assertion } });
    expect(await authorize(access(await token()), options)).toBe('owner@example.com');
    for (const changes of [
      { exp: undefined },
      { exp: Math.floor(Date.now() / 1000) - 1 },
      { iss: 'https://other.cloudflareaccess.com' },
      { aud: 'other-audience' },
      { email: 'intruder@example.com' },
    ])
      await expect(authorize(access(await token(changes)), options)).rejects.toMatchObject({
        status: 403,
      });
    await expect(authorize(access('forged'), options)).rejects.toMatchObject({ status: 403 });
    await expect(
      authorize(
        request('/api/overview', {
          headers: { 'Cf-Access-Authenticated-User-Email': options.ADMIN_EMAIL },
        }),
        options,
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

it('transforms controlled HTML portably, escapes metadata, restricts assets, and handles HEAD', async () => {
  const assets = vi.fn(async (request: Request | string) => {
    const method = typeof request === 'string' ? 'GET' : request.method;
    return new Response(
      method === 'HEAD'
        ? null
        : '<!doctype html><html lang="en"><head><script src="/theme.js"></script><link href="/assets/index.css"></head><body><script src="/assets/index.js"></script></body></html>',
    );
  });
  const options = {
    ...config,
    ASSETS: { fetch: assets },
    DASHBOARD_URL: 'https://example.com/"<attack>',
    TELEGRAM_BOT_USERNAME: 'bad"<name',
  } as Env;
  const response = await htmlShell(request('/mini/'), options, true);
  const text = await response.text();
  expect(text).toContain('/mini/assets/index.js');
  expect(text).toContain('https://telegram.org/js/telegram-web-app.js?64');
  expect(text).not.toContain('"<attack>');
  expect(text).not.toContain('bad"<name');
  const head = await htmlShell(request('/mini/', { method: 'HEAD' }), options, true);
  expect(head.status).toBe(200);
  expect(await head.text()).toBe('');
  expect((assets.mock.calls.at(-1)![0] as Request).method).toBe('GET');
  expect(await authRoute(request('/assets/index.js.map'), config)).toBeNull();
  expect(await authRoute(request('/.env'), config)).toBeNull();
  expect(await authRoute(request('/assets/unlisted.js'), options)).toBeNull();
  expect(await authRoute(request('/assets/.hidden.js'), options)).toBeNull();
  expect(await authRoute(request('/assets/index.js'), options)).toBeInstanceOf(Response);
});

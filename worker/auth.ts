import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from './env';
import { browserMethods, htmlShell, publicAssetPath } from './html-shell';
import { HttpError, json, readJson } from './http';

const keysets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const SESSION_COOKIE = '__Host-watchtower_session';
export const BROWSER_SESSION_SECONDS = 12 * 60 * 60;
const encode = (value: string) => new TextEncoder().encode(value);

export function isLocal(request: Request, env: Env) {
  return (
    env.DEV_MODE === 'true' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname)
  );
}
function configuredToken(env: Env) {
  return browserMethods(env).browserToken ? env.BROWSER_AUTH_TOKEN! : '';
}
function base64url(bytes: ArrayBuffer | Uint8Array) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
async function sessionKey(token: string) {
  const key = await crypto.subtle.digest(
    'SHA-256',
    encode(`watchtower:browser-session:v1\u0000${token}`),
  );
  return crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}
async function sessionOwner(request: Request, env: Env) {
  const token = configuredToken(env);
  if (!token) return null;
  const values = (request.headers.get('Cookie') || '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(SESSION_COOKIE.length + 1);
  const match = /^v1\.(\d{10,12})\.(\d{10,12})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(
    value,
  );
  if (!match) return null;
  const [, issued, expires, , signature] = match;
  const now = Math.floor(Date.now() / 1000);
  if (
    Number(issued) > now + 30 ||
    Number(expires) <= now ||
    Number(expires) - Number(issued) !== BROWSER_SESSION_SECONDS
  )
    return null;
  const bytes = Uint8Array.from(
    atob(signature.replace(/-/g, '+').replace(/_/g, '/') + '='),
    (character) => character.charCodeAt(0),
  );
  if (
    !(await crypto.subtle.verify(
      'HMAC',
      await sessionKey(token),
      bytes,
      encode(value.slice(0, value.lastIndexOf('.'))),
    ))
  )
    return null;
  verifyMutation(request, true);
  return 'browser-owner';
}
export async function authorize(request: Request, env: Env) {
  if (isLocal(request, env)) return 'local-owner';
  const browser = await sessionOwner(request, env);
  if (browser) return browser;
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!assertion)
    throw new HttpError(
      401,
      'Owner authentication required. Open the sign-in page or the Telegram Mini App.',
    );
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.ADMIN_EMAIL)
    throw new HttpError(401, 'Cloudflare Access is not configured for this installation.');
  const domain = env.ACCESS_TEAM_DOMAIN.replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain))
    throw new HttpError(503, 'Invalid Cloudflare Access team domain.');
  let keys = keysets.get(domain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${domain}/cdn-cgi/access/certs`));
    keysets.set(domain, keys);
  }
  try {
    const { payload } = await jwtVerify(assertion, keys, {
      issuer: domain,
      audience: env.ACCESS_AUD,
      algorithms: ['RS256'],
      requiredClaims: ['exp'],
    });
    if (
      typeof payload.email !== 'string' ||
      payload.email.toLowerCase() !== env.ADMIN_EMAIL.toLowerCase()
    )
      throw new Error('Not owner');
    return payload.email;
  } catch {
    throw new HttpError(403, 'Access is restricted to the bot owner.');
  }
}

// The routing layer wraps these responses in the normal dashboard security headers.
export async function authRoute(request: Request, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === '/api/auth/status') {
    if (request.method !== 'GET') throw new HttpError(405, 'GET only.');
    let authenticated = false;
    try {
      await authorize(request, env);
      authenticated = true;
    } catch (error) {
      if (!(error instanceof HttpError) || ![401, 403].includes(error.status)) throw error;
    }
    return json({ authenticated, ...browserMethods(env) });
  }
  if (path === '/api/auth/login' || path === '/api/auth/logout') {
    if (request.method !== 'POST') throw new HttpError(405, 'POST only.');
    verifyMutation(request, true);
    if (new URL(request.url).protocol !== 'https:')
      throw new HttpError(400, 'Browser sign-in requires HTTPS.');
    const response = json({ ok: true });
    if (path === '/api/auth/logout') {
      response.headers.set(
        'Set-Cookie',
        `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
      );
      return response;
    }
    const expected = configuredToken(env);
    if (!expected) throw new HttpError(503, 'Browser token sign-in is not configured.');
    const body = await readJson(request, 1024);
    const supplied = body && typeof body === 'object' && 'token' in body ? body.token : null;
    if (typeof supplied !== 'string' || !(await secureEqual(supplied, expected)))
      throw new HttpError(401, 'The sign-in token is incorrect.');
    const issued = Math.floor(Date.now() / 1000);
    const value = `v1.${issued}.${issued + BROWSER_SESSION_SECONDS}.${base64url(crypto.getRandomValues(new Uint8Array(16)))}`;
    const signature = base64url(
      await crypto.subtle.sign('HMAC', await sessionKey(expected), encode(value)),
    );
    response.headers.set(
      'Set-Cookie',
      `${SESSION_COOKIE}=${value}.${signature}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${BROWSER_SESSION_SECONDS}`,
    );
    return response;
  }
  if (path === '/' || path === '/login' || (await publicAssetPath(path, request, env))) {
    if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed.');
    return path === '/' || path === '/login' ? htmlShell(request, env) : env.ASSETS.fetch(request);
  }
  return null;
}
// Accept older installed clients while new clients use the current product name.
export function applicationHeader(
  request: Request,
  name: 'Request' | 'Group' | 'File-Name' | 'Work-Secret',
) {
  return request.headers.get(`X-Unspammed-${name}`) ?? request.headers.get(`X-Watchtower-${name}`);
}
export function verifyMutation(request: Request, requireOrigin = false) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.get('Origin');
  if ((requireOrigin && !origin) || (origin && origin !== new URL(request.url).origin))
    throw new HttpError(403, 'Cross-origin writes are blocked.');
  if (applicationHeader(request, 'Request') !== '1')
    throw new HttpError(403, 'Missing request protection header.');
}
export async function secureEqual(a: string, b: string) {
  const [left, right] = await Promise.all([
    crypto.subtle.digest('SHA-256', encode(a)),
    crypto.subtle.digest('SHA-256', encode(b)),
  ]);
  const l = new Uint8Array(left),
    r = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < l.length; i++) difference |= l[i] ^ r[i];
  return difference === 0;
}

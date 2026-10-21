import type { Env } from './env';
import { HttpError, json, readBody } from './http';
import { htmlShell, publicAssetPath } from './html-shell';

export const MINI_APP_MAX_AGE = 3600;

export async function authorizeMiniApp(request: Request, env: Env) {
  const raw = request.headers.get('X-Telegram-Init-Data') || '';
  const denied = () => new HttpError(401, 'Close and reopen the Mini App from the bot to sign in.');
  if (!env.TELEGRAM_BOT_TOKEN || !/^\d+$/.test(env.OWNER_TELEGRAM_ID))
    throw new HttpError(503, 'Telegram owner authentication is not configured.');
  if (!raw || raw.length > 8192) throw denied();
  const fields = new URLSearchParams(raw);
  const entries = [...fields];
  if (
    new Set(entries.map(([key]) => key)).size !== entries.length ||
    entries.some(([key, value]) => !/^[a-z_]+$/.test(key) || /[\r\n]/.test(value))
  )
    throw denied();
  const hash = fields.get('hash') || '';
  const date = fields.get('auth_date') || '';
  const age = Math.floor(Date.now() / 1000) - Number(date);
  if (
    !/^[a-f0-9]{64}$/.test(hash) ||
    !/^\d{1,12}$/.test(date) ||
    age < -30 ||
    age > MINI_APP_MAX_AGE
  )
    throw denied();
  const encode = (value: string) => new TextEncoder().encode(value);
  const key = await crypto.subtle.importKey(
    'raw',
    encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const secret = await crypto.subtle.sign('HMAC', key, encode(env.TELEGRAM_BOT_TOKEN));
  const signingKey = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const data = entries
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const signature = Uint8Array.from(hash.match(/../g)!, (value) => parseInt(value, 16));
  if (!(await crypto.subtle.verify('HMAC', signingKey, signature, encode(data)))) throw denied();
  let user: { id?: unknown; is_bot?: boolean };
  try {
    user = JSON.parse(fields.get('user') || 'null');
  } catch {
    throw denied();
  }
  if (!user || !Number.isSafeInteger(user.id) || Number(user.id) <= 0 || user.is_bot)
    throw denied();
  if (String(user.id) !== env.OWNER_TELEGRAM_ID)
    throw new HttpError(403, 'Access is restricted to the bot owner.');
  return `telegram:${user.id}`;
}

// Only a static shell is public. API routes still authenticate every request.
export async function miniAppAsset(request: Request, env: Env) {
  const url = new URL(request.url);
  const path = url.pathname.slice('/mini'.length);
  if (!['GET', 'HEAD'].includes(request.method)) throw new HttpError(405, 'Method not allowed.');
  if (path === '') {
    url.pathname += '/';
    return Response.redirect(url.href, 302);
  }
  if (path !== '/' && !(await publicAssetPath(path, request, env)))
    throw new HttpError(404, 'Unknown Mini App resource.');
  url.pathname = path;
  const target = new Request(url, request);
  return path === '/' ? htmlShell(target, env, true) : env.ASSETS.fetch(target);
}

export async function exportToTelegram(request: Request, env: Env) {
  if (request.method !== 'POST') throw new HttpError(405, 'POST only.');
  const name = request.headers.get('X-Watchtower-File-Name') || '';
  if (!/^[a-zA-Z0-9._-]{1,100}\.json$/.test(name))
    throw new HttpError(400, 'Invalid export filename.');
  const bytes = await readBody(request, 20_000_000);
  const body = new FormData();
  body.set('chat_id', env.OWNER_TELEGRAM_ID);
  body.set('document', new Blob([bytes], { type: 'application/json' }), name);
  let result: { ok?: boolean };
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`,
      {
        method: 'POST',
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(45_000),
      },
    );
    result = await response.json();
    if (!response.ok || !result.ok) throw new Error('Delivery failed');
  } catch {
    throw new HttpError(
      502,
      'Could not deliver the export. Start a private chat with the bot and try again.',
    );
  }
  return json({ ok: true });
}

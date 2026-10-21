import type { Env } from './env';
import { HttpError } from './http';

const builtAssetPath = (path: string) =>
  /^\/assets\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(?:js|css)$/.test(path);
const assetLists = new WeakMap<Env['ASSETS'], ReadonlySet<string>>();

function referencedAssets(html: string): ReadonlySet<string> {
  const paths = new Set<string>();
  // Vite currently emits one bundle and stylesheet. Include its modulepreloads too;
  // additional asset types or lazy chunks need an explicit build-manifest contract.
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/gi) || []) {
    const path = /\b(?:src|href)\s*=\s*(['"])([^'"]*)\1/i.exec(tag)?.[2];
    if (path && builtAssetPath(path)) paths.add(path);
  }
  return paths;
}

async function fetchShell(request: Request, env: Env) {
  const url = new URL(request.url);
  url.pathname = '/';
  url.search = '';
  // Static build reads need no owner credentials or user-supplied headers.
  return env.ASSETS.fetch(new Request(url, { method: 'GET' }));
}

export async function publicAssetPath(path: string, request: Request, env: Env) {
  if (path === '/theme.js' || path === '/favicon.svg') return true;
  if (!builtAssetPath(path)) return false;
  let assets = assetLists.get(env.ASSETS);
  if (!assets) {
    const response = await fetchShell(request, env);
    if (!response.ok) throw new HttpError(503, 'The dashboard build is unavailable.');
    assets = referencedAssets(await response.text());
    assetLists.set(env.ASSETS, assets);
  }
  return assets.has(path);
}

export function escapeAttribute(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
}

export function browserMethods(env: Env) {
  const dashboard = env.DASHBOARD_URL || env.PUBLIC_URL || env.WORKER_URL || '';
  let dashboardUrl = '';
  try {
    const url = new URL(dashboard);
    if (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    )
      dashboardUrl = url.href;
  } catch {
    // A missing optional browser URL must never break Telegram authentication.
  }
  return {
    telegram: !!env.TELEGRAM_BOT_TOKEN && /^\d+$/.test(env.OWNER_TELEGRAM_ID),
    botUsername: /^[a-zA-Z0-9_]{5,32}$/.test(env.TELEGRAM_BOT_USERNAME || '')
      ? env.TELEGRAM_BOT_USERNAME!
      : '',
    browserToken: /^[A-Za-z0-9_-]{43,256}$/.test(env.BROWSER_AUTH_TOKEN || ''),
    cloudflareAccess: !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD && env.ADMIN_EMAIL),
    dashboardUrl,
  };
}

// Transform only our controlled Vite HTML shell. No runtime-specific HTML parser is needed.
export async function htmlShell(request: Request, env: Env, miniApp = false) {
  const response = await fetchShell(request, env);
  if (!response.ok) return response;
  let html = await response.text();
  if (!/<html(?:\s|>)/i.test(html) || !/<head(?:\s|>)/i.test(html))
    throw new HttpError(503, 'The dashboard build is unavailable. Build the application first.');
  assetLists.set(env.ASSETS, referencedAssets(html));
  const methods = browserMethods(env);
  const attributes: Record<string, string> = {
    'data-mini-app': String(miniApp),
    'data-bot-username': methods.botUsername,
    'data-dashboard-url': methods.dashboardUrl,
    'data-browser-auth': String(methods.browserToken),
    'data-access-auth': String(methods.cloudflareAccess),
    'data-telegram-auth': String(methods.telegram),
  };
  html = html.replace(
    /<html(?=[\s>])([^>]*)>/i,
    (_tag, rest: string) =>
      `<html${rest} ${Object.entries(attributes)
        .map(([name, value]) => `${name}="${escapeAttribute(value)}"`)
        .join(' ')}>`,
  );
  if (miniApp) {
    html = html.replace(/\b(src|href)=(['"])(\/[^'"]*)\2/gi, (tag, name, quote, value) =>
      value.startsWith('//') ? tag : `${name}=${quote}/mini${value}${quote}`,
    );
    html = html.replace(
      /<head(?=[\s>])[^>]*>/i,
      '$&<script src="https://telegram.org/js/telegram-web-app.js?64"></script>',
    );
  }
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.delete('Content-Encoding');
  headers.delete('ETag');
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(request.method === 'HEAD' ? null : html, {
    status: response.status,
    headers,
  });
}

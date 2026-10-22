// Explicit smoke checks for a disposable hosted installation. The default mode
// does not change Telegram, models, or moderation. --cron runs pending background
// work and is restricted to an explicitly designated empty test fixture.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { canonicalEnvironment } from './setup-env.mjs';
import { parseOptions, validatePublicOrigin } from './setup-lib.mjs';

async function main() {
  const options = parseOptions(process.argv.slice(2), {
    flags: ['--database', '--cron'],
    values: ['--url'],
    usage:
      'UNSPAMMED_ENV_FILE=private-test.env node scripts/verify-hosted.mjs --url https://test.example [--database] [--cron]',
  });
  const file = process.env.UNSPAMMED_ENV_FILE ?? process.env.WATCHTOWER_ENV_FILE;
  if (!file)
    throw new Error('Select an explicit private test environment with UNSPAMMED_ENV_FILE.');
  const source = readFileSync(file, 'utf8');
  let env;
  try {
    env = file.endsWith('.json') ? JSON.parse(source) : parseEnv(source);
  } catch {
    throw new Error('The explicit private test environment could not be parsed.');
  }
  env = canonicalEnvironment(env);
  if (options['--cron'] && env.UNSPAMMED_TEST_FIXTURE !== 'true')
    throw new Error(
      'Cron checks require UNSPAMMED_TEST_FIXTURE=true in an empty disposable test environment; pending background work may execute.',
    );
  const origin = validatePublicOrigin(options['--url'] || env.PUBLIC_URL);
  const expectedOrigin = validatePublicOrigin(env.PUBLIC_URL || origin);
  assert.equal(
    origin,
    expectedOrigin,
    'The test environment must name the deployment being checked.',
  );
  const results = [];
  async function request(name, path, status, init = {}) {
    const response = await fetch(origin + path, {
      redirect: 'manual',
      signal: AbortSignal.timeout(options['--cron'] ? 290_000 : 30_000),
      ...init,
    });
    assert.equal(
      response.status,
      status,
      `${name}: expected HTTP ${status}, received ${response.status}`,
    );
    results.push({ name, status: response.status });
    return response;
  }
  const cancel = async (response) => {
    await response.body?.cancel();
  };
  const health = await request('public health', '/health', 200);
  assert.equal((await health.json()).service, 'unspammed');
  const root = await request('public browser shell', '/', 200);
  assert.equal(root.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(root.headers.get('Cache-Control'), 'no-store');
  const html = await root.text();
  for (const key of ['BROWSER_AUTH_TOKEN', 'TELEGRAM_BOT_TOKEN', 'DATABASE_URL'])
    if (env[key]) assert(!html.includes(env[key]), 'A credential appeared in HTML.');
  const assets = [...html.matchAll(/(?:src|href)="([^"\s]+\.(?:js|css))"/g)].map(
    (match) => match[1],
  );
  assert(assets.some((asset) => asset.startsWith('/assets/')));
  for (const asset of assets) await cancel(await request('built asset', asset, 200));
  await cancel(await request('browser HEAD', '/', 200, { method: 'HEAD' }));
  const mini = await request('public Mini App shell', '/mini/', 200);
  assert(!mini.headers.has('X-Frame-Options'));
  assert.match(
    mini.headers.get('Content-Security-Policy'),
    /frame-ancestors https:\/\/web.telegram.org/,
  );
  assert((await mini.text()).includes('/mini/assets/'));
  for (const path of ['/api/overview', '/mini/api/overview'])
    await cancel(await request('anonymous API denied', path, 401));
  const privateFile = await fetch(origin + '/.env', {
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  assert([401, 404].includes(privateFile.status), 'Private environment files must not be public.');
  results.push({ name: 'private environment file denied', status: privateFile.status });
  await cancel(privateFile);
  for (const path of ['/mini/assets/unlisted.js', '/mini/assets/unlisted.js.map'])
    await cancel(await request('private/unlisted resource denied', path, 404));
  await cancel(
    await request('webhook wrong secret', '/telegram/webhook', 401, { method: 'POST', body: '{}' }),
  );
  await cancel(
    await request('internal work wrong secret', '/internal/work', 401, {
      method: 'POST',
      body: '{}',
    }),
  );
  // /api/cron exists on portable adapters; Workers use their native cron handler.
  const cron = await fetch(origin + '/api/cron', {
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(cron.status, 401);
  await cancel(cron);
  results.push({ name: 'cron anonymous denied', status: cron.status });
  assert(env.BROWSER_AUTH_TOKEN, 'Enable browser auth in the test environment.');
  const headers = {
    Origin: expectedOrigin,
    'Content-Type': 'application/json',
    'X-Unspammed-Request': '1',
  };
  await cancel(
    await request('wrong browser token denied', '/api/auth/login', 401, {
      method: 'POST',
      headers,
      body: JSON.stringify({ token: 'wrong-test-token' }),
    }),
  );
  const login = await request('browser token exchange', '/api/auth/login', 200, {
    method: 'POST',
    headers,
    body: JSON.stringify({ token: env.BROWSER_AUTH_TOKEN }),
  });
  const cookieHeader = login.headers.get('set-cookie');
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/'])
    assert(cookieHeader.includes(attribute));
  const Cookie = cookieHeader.split(';')[0];
  await cancel(login);
  const status = await request('browser session accepted', '/api/auth/status', 200, {
    headers: { Cookie },
  });
  assert.equal((await status.json()).authenticated, true);
  await cancel(
    await request('cookie cannot authenticate Mini App', '/mini/api/overview', 401, {
      headers: { Cookie },
    }),
  );
  await cancel(
    await request('foreign Origin write denied', '/api/settings', 403, {
      method: 'PUT',
      headers: { ...headers, Cookie, Origin: 'https://foreign.example' },
      body: '{}',
    }),
  );
  const launch = (owner, age = 0) => {
    const fields = new URLSearchParams({
      auth_date: String(Math.floor(Date.now() / 1000) - age),
      user: JSON.stringify({ id: Number(owner), first_name: 'Verification' }),
    });
    const data = [...fields]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const key = createHmac('sha256', 'WebAppData').update(env.TELEGRAM_BOT_TOKEN).digest();
    fields.set('hash', createHmac('sha256', key).update(data).digest('hex'));
    return fields.toString();
  };
  assert(env.OWNER_TELEGRAM_ID && env.TELEGRAM_BOT_TOKEN, 'Supply the test bot and numeric owner.');
  const ownerLaunch = launch(env.OWNER_TELEGRAM_ID);
  await cancel(
    await request('expired Telegram launch denied', '/mini/api/overview', 401, {
      headers: { 'X-Telegram-Init-Data': launch(env.OWNER_TELEGRAM_ID, 7200) },
    }),
  );
  await cancel(
    await request('non-owner Telegram launch denied', '/mini/api/overview', 403, {
      headers: { 'X-Telegram-Init-Data': launch(String(Number(env.OWNER_TELEGRAM_ID) + 1)) },
    }),
  );
  await cancel(
    await request('Telegram cannot authenticate browser API', '/api/overview', 401, {
      headers: { 'X-Telegram-Init-Data': ownerLaunch },
    }),
  );
  if (options['--database']) {
    for (const [name, path, auth] of [
      ['browser PostgreSQL read', '/api/overview', { Cookie }],
      ['Telegram PostgreSQL read', '/mini/api/overview', { 'X-Telegram-Init-Data': ownerLaunch }],
    ]) {
      const response = await request(name, path, 200, { headers: auth });
      const data = await response.json();
      assert.equal(data.chatId, env.TELEGRAM_CHAT_ID);
      assert.equal(data.storage.backend, 'postgres');
      assert.equal(data.storage.ready, true);
      assert.equal(data.settings.mode, 'observe', 'Use an Observe-only test installation.');
    }
    for (const path of ['/api/groups', '/api/datasets', '/api/export'])
      await cancel(await request('authenticated data read', path, 200, { headers: { Cookie } }));
  }
  if (options['--cron']) {
    assert(
      options['--database'] && env.CRON_SECRET,
      'Cron checks require the disposable database environment.',
    );
    await cancel(
      await request('authenticated portable cron', '/api/cron', 200, {
        headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
      }),
    );
  }
  await cancel(
    await request('browser logout', '/api/auth/logout', 200, {
      method: 'POST',
      headers: { ...headers, Cookie },
      body: '{}',
    }),
  );
  console.log(
    JSON.stringify(
      {
        origin,
        checkedAt: new Date().toISOString(),
        database: !!options['--database'],
        explicitCron: !!options['--cron'],
        results,
      },
      null,
      2,
    ),
  );
}
main().catch((error) => {
  console.error(error?.message || 'Hosted verification failed.');
  process.exitCode = 1;
});

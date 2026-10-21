import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import pg from 'pg';

// Reproduce a new checkout without inheriting deployment files, tokens, or shell credentials.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, '.tmp'), { recursive: true });
const clean = mkdtempSync(join(root, '.tmp/fresh-install-'));
const childEnv = Object.fromEntries(
  ['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT']
    .filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
);
childEnv.CI = 'true';
const run = (command, args, cwd = clean, env = childEnv) => {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 8_000_000,
  });
  if (result.status !== 0) {
    // Fixture output has no live secrets; retain diagnostics locally for investigation.
    writeFileSync(
      join(clean, 'verification-error.log'),
      `${result.stdout || ''}\n${result.stderr || ''}`,
      { mode: 0o600 },
    );
    throw new Error(
      `${command} ${args.join(' ')} failed; see ${join(clean, 'verification-error.log')}.`,
    );
  }
  return result.stdout;
};
let server;
let client;
let schema;
let createdSchema = false;
let runtimeRole;
try {
  const listing = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(listing.status, 0, 'Run this check from the source checkout.');
  for (const file of new Set(listing.stdout.split('\0').filter(Boolean))) {
    if (
      /^(?:\.git\/|\.tmp\/|\.watchtower\/|\.wrangler\/|\.vercel\/|node_modules\/|dist\/|coverage\/|wrangler\.(?:production|generated)\.jsonc$)/.test(
        file,
      )
    )
      continue;
    if (/^(?:\.env|\.dev.vars)(?:$|\.)/.test(file) && !file.endsWith('.example')) continue;
    if (!existsSync(join(root, file))) continue;
    mkdirSync(dirname(join(clean, file)), { recursive: true });
    copyFileSync(join(root, file), join(clean, file));
  }
  assert(!existsSync(join(clean, '.env')) && !existsSync(join(clean, '.dev.vars')));
  console.log('Clean source copy contains no deployment credentials. Installing from lockfile…');
  run('npm', ['ci', '--no-audit', '--no-fund']);
  run('npm', ['run', 'typecheck']);
  run('npm', ['run', 'build']);
  console.log('Clean npm ci, typecheck, and production build passed.');
  const fixture = {
    DEV_MODE: 'false',
    PUBLIC_URL: 'https://fresh-install.example',
    DATABASE_URL: 'postgres://fixture:fixture@database.example/watchtower',
    TELEGRAM_BOT_TOKEN: '123456789:FAKE_TEST_TOKEN_NEVER_CONTACT_TELEGRAM',
    TELEGRAM_CHAT_ID: '-100' + String(randomBytes(4).readUInt32BE()).padStart(10, '0'),
    OWNER_TELEGRAM_ID: '135791357',
    TELEGRAM_BOT_USERNAME: 'fresh_install_bot',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    WATCHTOWER_NAME: 'fresh-install-fixture',
  };
  const save = (path, values) =>
    writeFileSync(
      path,
      Object.entries(values)
        .map(([k, v]) => `${k}='${v}'`)
        .join('\n') + '\n',
      { mode: 0o600 },
    );
  for (const provider of ['cloudflare', 'railway', 'digitalocean', 'vercel', 'render', 'fly']) {
    const directory = join(clean, '.fixtures', provider);
    mkdirSync(directory, { recursive: true });
    save(join(directory, '.env'), fixture);
    const command = [join(clean, 'scripts/setup.mjs'), '--provider', provider, '--browser-auth'];
    run(process.execPath, command, directory);
    const before = readFileSync(join(directory, '.watchtower/runtime.env'), 'utf8');
    run(process.execPath, command, directory);
    assert.equal(
      readFileSync(join(directory, '.watchtower/runtime.env'), 'utf8'),
      before,
      'Reruns must preserve generated secrets.',
    );
    run(process.execPath, [join(clean, 'scripts/setup.mjs'), '--doctor'], directory);
    const generated = parseEnv(before);
    assert.equal(generated.OWNER_TELEGRAM_ID, fixture.OWNER_TELEGRAM_ID);
    assert.equal(generated.TELEGRAM_CHAT_ID, fixture.TELEGRAM_CHAT_ID);
    assert(generated.BROWSER_AUTH_TOKEN.length >= 43);
    assert(!('DATABASE_ADMIN_URL' in generated));
    if (provider === 'cloudflare') {
      const config = JSON.parse(readFileSync(join(directory, 'wrangler.generated.jsonc'), 'utf8'));
      assert.equal(config.account_id, fixture.CLOUDFLARE_ACCOUNT_ID);
      for (const value of [
        fixture.DATABASE_URL,
        fixture.TELEGRAM_BOT_TOKEN,
        generated.BROWSER_AUTH_TOKEN,
      ])
        assert(!JSON.stringify(config).includes(value));
    }
  }
  console.log(
    'All six provider setup paths passed with independent fixture identities and stable generated secrets.',
  );
  const database = process.env.TEST_POSTGRES_URL;
  if (!database) {
    console.log(
      'Database/runtime verification skipped: set TEST_POSTGRES_URL to a disposable loopback PostgreSQL database.',
    );
  } else {
    const address = new URL(database);
    assert.equal(
      address.hostname,
      '127.0.0.1',
      'Only an explicitly supplied disposable loopback database is allowed.',
    );
    assert(['postgres:', 'postgresql:'].includes(address.protocol));
    client = new pg.Client({ connectionString: database, ssl: false });
    await client.connect();
    schema = `watchtower_g${fixture.TELEGRAM_CHAT_ID.slice(1)}`;
    const existing = await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema]);
    assert.equal(existing.rowCount, 0, 'Refuse to use an existing application schema.');
    runtimeRole = `fresh_runtime_${randomBytes(6).toString('hex')}`;
    await client.query(`CREATE ROLE "${runtimeRole}" LOGIN`);
    await client.query(`CREATE SCHEMA "${schema}" AUTHORIZATION "${runtimeRole}"`);
    createdSchema = true;
    const runtimeDatabase = new URL(database);
    runtimeDatabase.username = runtimeRole;
    runtimeDatabase.password = '';
    const runtime = parseEnv(
      readFileSync(join(clean, '.fixtures/railway/.watchtower/runtime.env'), 'utf8'),
    );
    Object.assign(runtime, {
      DATABASE_URL: runtimeDatabase.href,
      DATABASE_SSL_MODE: 'disable',
      WATCHTOWER_SCHEDULER: 'false',
    });
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    Object.assign(runtime, { PORT: String(port), HOST: '127.0.0.1' });
    const envPath = join(clean, '.env');
    save(envPath, runtime);
    run('npm', ['run', 'database:setup']);
    await client.query(
      `UPDATE "${schema}".config SET value=jsonb_set(value::jsonb,'{batchSeconds}','27')::text WHERE id=1`,
    );
    run('npm', ['run', 'database:setup']);
    const preserved = await client.query(`SELECT value FROM "${schema}".config WHERE id=1`);
    assert.equal(JSON.parse(preserved.rows[0].value).batchSeconds, 27);
    // Exercise the exact production dependencies retained by the Docker build.
    run('npm', ['prune', '--omit=dev', '--no-audit', '--no-fund']);
    server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: clean,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    server.stdout.on('data', (chunk) => {
      logs += chunk;
    });
    server.stderr.on('data', (chunk) => {
      logs += chunk;
    });
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; ; attempt++) {
      try {
        assert.equal((await fetch(`${base}/health`)).status, 200);
        break;
      } catch {
        if (attempt >= 100 || server.exitCode !== null)
          throw new Error(`Fresh runtime did not start: ${logs}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const request = (path, options) => fetch(base + path, { redirect: 'manual', ...options });
    assert.equal((await request('/')).status, 200);
    assert.equal((await request('/', { method: 'HEAD' })).status, 200);
    assert.equal((await request('/mini/')).status, 200);
    assert.equal((await request('/mini/api/overview')).status, 401);
    assert.equal((await request('/api/overview')).status, 401);
    assert.equal((await request('/api/cron')).status, 401);
    assert.equal((await request('/telegram/webhook', { method: 'POST' })).status, 401);
    const login = await request('/api/auth/login', {
      method: 'POST',
      headers: {
        Origin: runtime.PUBLIC_URL,
        'Content-Type': 'application/json',
        'X-Watchtower-Request': '1',
      },
      body: JSON.stringify({ token: runtime.BROWSER_AUTH_TOKEN }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const overview = await request('/api/overview', { headers: { Cookie: cookie } });
    assert.equal(overview.status, 200);
    const data = await overview.json();
    assert.equal(data.owner, 'browser-owner');
    assert.equal(data.chatId, fixture.TELEGRAM_CHAT_ID);
    assert.equal(data.storage.backend, 'postgres');
    assert.equal(data.storage.ready, true);
    assert.equal(data.settings.mode, 'observe');
    const launch = new URLSearchParams({
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify({ id: Number(fixture.OWNER_TELEGRAM_ID), first_name: 'Fixture' }),
    });
    const signedText = [...launch]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const signingKey = createHmac('sha256', 'WebAppData')
      .update(fixture.TELEGRAM_BOT_TOKEN)
      .digest();
    launch.set('hash', createHmac('sha256', signingKey).update(signedText).digest('hex'));
    const miniOverview = await request('/mini/api/overview', {
      headers: { 'X-Telegram-Init-Data': launch.toString() },
    });
    assert.equal(miniOverview.status, 200);
    assert.equal((await miniOverview.json()).owner, `telegram:${fixture.OWNER_TELEGRAM_ID}`);
    assert.equal(
      (await request('/api/overview', { headers: { 'X-Telegram-Init-Data': launch.toString() } }))
        .status,
      401,
    );
    assert.equal(
      (await request('/mini/api/overview', { headers: { Cookie: cookie } })).status,
      401,
    );
    assert.equal(
      (
        await request('/api/settings', {
          method: 'POST',
          headers: {
            Cookie: cookie,
            Origin: 'https://attacker.example',
            'X-Watchtower-Request': '1',
          },
        })
      ).status,
      403,
    );
    console.log(
      'Fresh PostgreSQL bootstrap/rerun and production-only Node runtime passed: browser login, owner data, Mini App, webhook, cron, and CSRF checks.',
    );
  }
  console.log(
    'Fresh-install verification passed. No hosting resources or Telegram settings were changed.',
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Fresh-install verification failed.');
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) {
    const closed = new Promise((resolve) => server.once('exit', resolve));
    server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 5_000);
    await closed;
    clearTimeout(timer);
  }
  if (client) {
    if (createdSchema) await client.query(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
    if (runtimeRole) await client.query(`DROP ROLE "${runtimeRole}"`).catch(() => {});
    await client.end();
  }
  if (!process.exitCode && !process.argv.includes('--keep'))
    rmSync(clean, { recursive: true, force: true });
  else console.log(`Verification directory: ${clean}`);
}

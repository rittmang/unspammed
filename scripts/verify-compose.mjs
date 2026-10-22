// Explicit integration check: requires a working Docker Engine + Compose plugin.
// Uses only disposable databases, fake Telegram identities and an internal TLS CA.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { dotenvLine, safeErrorMessage } from './setup-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cwd = mkdtempSync(join(tmpdir(), 'unspammed-compose-'));
const identifier = randomBytes(6).toString('hex');
const image = `unspammed-compose-check:${identifier}`;
const project = `unspammed-check-${identifier}`;
const composeEnv = '.watchtower/compose.env';
const domain = 'compose-fixture.example';
const chat = `-100${Date.now().toString().slice(-10)}`;
const schema = `watchtower_g${chat.slice(1)}`;
const env = { ...process.env, COMPOSE_PROJECT_NAME: project };
const secretEnvironment = {};
let browserCookie = '';
// Never import an installed application's environment through Compose precedence.
for (const key of [
  'COMPOSE_FILE',
  'COMPOSE_PROFILES',
  'COMPOSE_ENV_FILES',
  'UNSPAMMED_VM_ENV',
  'UNSPAMMED_ENV_FILE',
  'UNSPAMMED_DATABASE_PASSWORD',
  'UNSPAMMED_DOMAIN',
  'UNSPAMMED_BIND',
  'UNSPAMMED_PORT',
  'WATCHTOWER_VM_ENV',
  'WATCHTOWER_ENV_FILE',
  'POSTGRES_PASSWORD',
  'WATCHTOWER_DATABASE_PASSWORD',
  'WATCHTOWER_DOMAIN',
  'WATCHTOWER_BIND',
  'WATCHTOWER_PORT',
])
  delete env[key];
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 600000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} failed (exit ${result.status}). ${String(result.stderr || '').slice(-2000)}`,
    );
  return result.stdout || '';
}
function compose(args, options = {}) {
  return run('docker', ['compose', '--env-file', composeEnv, ...args], options);
}
function sql(query) {
  return compose([
    'exec',
    '-T',
    'db',
    'psql',
    '-XAt',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'watchtower_admin',
    '-d',
    'watchtower',
    '-c',
    query,
  ]).trim();
}
function readInputs() {
  return parseEnv(readFileSync(join(cwd, 'app.env'), 'utf8'));
}
function saveInputs(input) {
  writeFileSync(
    join(cwd, 'app.env'),
    `${Object.entries(input)
      .map(([key, value]) => dotenvLine(key, value))
      .join('\n')}\n`,
    { mode: 0o600 },
  );
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 90000) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await pause(1000);
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for the disposable deployment.');
}
let port;
let ca;
function https(path, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        servername: domain,
        ca,
        path,
        method,
        headers: { Host: domain, ...headers },
      },
      (res) => {
        let response = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          response += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: response }),
        );
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('HTTPS check timed out.')));
    req.end(body);
  });
}

try {
  run('docker', ['info'], { stdio: 'ignore' });
  run('docker', ['compose', 'version'], { stdio: 'ignore' });
  const files = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
  })
    .split('\0')
    .filter(Boolean);
  const exact = new Set([
    '.gitignore',
    '.dockerignore',
    'Dockerfile',
    'docker-compose.yml',
    'package.json',
    'package-lock.json',
    'index.html',
    'vite.config.ts',
    'tsconfig.json',
  ]);
  for (const file of files) {
    if (!exact.has(file) && !/^(?:src|shared|public|worker|server|scripts|deploy\/vm)\//.test(file))
      continue;
    const target = join(cwd, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, file), target);
  }
  // The override publishes only a random loopback TLS port and uses an internal
  // certificate authority. No ACME requests or public DNS are involved.
  writeFileSync(
    join(cwd, 'Caddyfile.test'),
    `${domain} {\n  tls internal\n  reverse_proxy watchtower:3000\n}\n`,
  );
  writeFileSync(
    join(cwd, 'docker-compose.override.yml'),
    `services:\n  watchtower:\n    image: ${image}\n    ports: !reset []\n  caddy:\n    ports: !override\n      - '127.0.0.1:0:443'\n    volumes:\n      - ./Caddyfile.test:/etc/caddy/Caddyfile:ro\n`,
  );
  // These deliberately unignored custom names also cover source/asset directories
  // that Docker copies wholesale. The context must filter them before transfer.
  const privateContextFiles = [
    'custom-production.credentials',
    'server/custom-production.credentials',
    'public/custom-production.credentials',
  ];
  for (const file of privateContextFiles)
    writeFileSync(join(cwd, file), 'FAKE_PRIVATE_BUILD_CONTEXT_SENTINEL');
  saveInputs({
    PUBLIC_URL: `https://${domain}`,
    DATABASE_URL: '',
    DATABASE_SSL_MODE: '',
    TELEGRAM_BOT_TOKEN: '987654321:FAKE_FIXTURE_TOKEN_NEVER_CONTACT_TELEGRAM',
    TELEGRAM_BOT_USERNAME: 'compose_fixture_bot',
    OWNER_TELEGRAM_ID: '234567890',
    TELEGRAM_CHAT_ID: chat,
    TELEGRAM_API_ID: '12345',
    TELEGRAM_API_HASH: 'a'.repeat(32),
    TELEGRAM_SESSION_KEY: randomBytes(32).toString('hex'),
    COMPOSE_PROFILES: 'bundled-db,https',
    UNSPAMMED_DOMAIN: domain,
  });
  console.log(
    'Installing a disposable Compose deployment with bundled PostgreSQL and local TLS...',
  );
  run('sh', ['deploy/vm/install.sh'], { stdio: 'inherit' });
  const input = readInputs();
  const runtime = parseEnv(readFileSync(join(cwd, '.watchtower/runtime.env'), 'utf8'));
  Object.assign(secretEnvironment, input, runtime);
  assert.equal(runtime.DATABASE_ADMIN_URL, undefined);
  assert.equal(
    sql(
      "SELECT rolsuper::text || '|' || rolcreatedb::text || '|' || rolcreaterole::text FROM pg_roles WHERE rolname='watchtower'",
    ),
    'false|false|false',
  );
  assert.equal(
    sql(`SELECT schema_owner FROM information_schema.schemata WHERE schema_name='${schema}'`),
    'watchtower',
  );
  assert.equal(JSON.parse(sql(`SELECT value FROM "${schema}".config WHERE id=1`)).mode, 'observe');
  compose(['cp', 'caddy:/data/caddy/pki/authorities/local/root.crt', join(cwd, 'root.crt')]);
  ca = readFileSync(join(cwd, 'root.crt'));
  port = Number(compose(['port', 'caddy', '443']).trim().split(':').at(-1));
  assert.equal((await https('/health')).status, 200);
  assert.equal((await https('/api/overview')).status, 401);
  assert.equal((await https('/mini/api/overview')).status, 401);
  assert.equal((await https('/api/cron')).status, 401);
  assert.equal((await https('/telegram/webhook', { method: 'POST', body: '{}' })).status, 401);
  assert.notEqual((await https('/.env')).status, 200);
  const login = await https('/api/auth/login', {
    method: 'POST',
    headers: {
      Origin: `https://${domain}`,
      'X-Unspammed-Request': '1',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token: runtime.BROWSER_AUTH_TOKEN }),
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers['set-cookie']?.[0] || '';
  assert.ok(/HttpOnly/i.test(setCookie), 'Browser cookie must be HttpOnly.');
  assert.ok(/Secure/i.test(setCookie), 'Browser cookie must be Secure.');
  const cookie = setCookie.split(';')[0];
  browserCookie = cookie;
  assert.equal((await https('/api/overview', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await https('/mini/api/overview', { headers: { Cookie: cookie } })).status, 401);
  assert.equal(
    (await https('/api/cron', { headers: { Authorization: `Bearer ${runtime.CRON_SECRET}` } }))
      .status,
    200,
  );
  sql(
    `INSERT INTO "${schema}".datasets (id,name,created_at) VALUES ('restart-fixture','Compose restart fixture',${Date.now()})`,
  );
  const previousRun = Number(sql(`SELECT last_run_at FROM "${schema}".work_state WHERE id=1`));
  assert.ok(previousRun > 0);
  console.log('HTTPS/authentication passed. Waiting for the actual built-in minute scheduler...');
  await until(
    () => Number(sql(`SELECT last_run_at FROM "${schema}".work_state WHERE id=1`)) > previousRun,
    80000,
  );
  compose(['stop', 'watchtower', 'db'], { stdio: 'inherit' });
  compose(['up', '-d', '--wait', 'db'], { stdio: 'inherit' });
  compose(['up', '-d', '--wait', 'watchtower'], { stdio: 'inherit' });
  assert.equal(
    sql(`SELECT name FROM "${schema}".datasets WHERE id='restart-fixture'`),
    'Compose restart fixture',
  );
  assert.equal((await https('/api/overview', { headers: { Cookie: cookie } })).status, 200);
  console.log(
    'Database/app restart preserved saved data and browser sessions. Rerunning installation...',
  );
  run('sh', ['deploy/vm/install.sh'], { stdio: 'inherit' });
  const again = readInputs();
  for (const key of [
    'DATABASE_URL',
    'DATABASE_ROOT_CHAT_ID',
    'POSTGRES_PASSWORD',
    'UNSPAMMED_DATABASE_PASSWORD',
    'BROWSER_AUTH_TOKEN',
    'TELEGRAM_WEBHOOK_SECRET',
    'CRON_SECRET',
    'TELEGRAM_SESSION_KEY',
  ])
    assert.equal(again[key], input[key]);
  assert.equal(
    sql(`SELECT name FROM "${schema}".datasets WHERE id='restart-fixture'`),
    'Compose restart fixture',
  );
  // Inspect the transmitted build context itself, not just the runtime image.
  console.log('Checking that custom credential files stay out of the Docker build context...');
  run('docker', ['build', '-f', '-', '-t', `${image}-context`, '.'], {
    input: `FROM node:22-bookworm-slim\nCOPY . /context\nRUN test -f /context/package.json && test -f /context/server/index.ts && test -f /context/public/theme.js && test ! -e /context/app.env && test ! -e /context/.watchtower${privateContextFiles.map((file) => ` && test ! -e /context/${file}`).join('')}\n`,
  });
  console.log(
    'Compose integration passed: verified local TLS, private APIs, restricted PostgreSQL role, minute scheduling, restart recovery, repeat installation and build-context privacy.',
  );
  console.log(
    'This is a local Docker check; it does not verify any cloud account or physical Telegram client.',
  );
} catch (error) {
  let message = safeErrorMessage(error, secretEnvironment);
  if (browserCookie) message = message.replaceAll(browserCookie, '[redacted browser cookie]');
  console.error(message);
  process.exitCode = 1;
} finally {
  try {
    if (existsSync(join(cwd, composeEnv)))
      compose(['down', '--volumes', '--remove-orphans'], { stdio: 'ignore', timeout: 120000 });
  } catch {
    console.error(`Disposable Compose cleanup failed; inspect Docker project ${project}.`);
    process.exitCode = 1;
  }
  spawnSync('docker', ['image', 'rm', '-f', image, `${image}-context`], {
    cwd,
    env,
    stdio: 'ignore',
    timeout: 120000,
  });
  rmSync(cwd, { recursive: true, force: true });
}

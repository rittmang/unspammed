import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { dotenvLine } from '../scripts/setup-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = {
  PUBLIC_URL: 'https://fixture.example',
  DATABASE_URL: 'postgresql://app:fixture-only@database.example/watchtower',
  TELEGRAM_BOT_TOKEN: '987654321:FAKE_FIXTURE_TOKEN_NEVER_CONTACT_TELEGRAM',
  OWNER_TELEGRAM_ID: '234567890',
  TELEGRAM_CHAT_ID: '-1009876543210',
};
function environment(extra = {}) {
  return {
    ...Object.fromEntries(
      ['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT']
        .filter((key) => process.env[key])
        .map((key) => [key, process.env[key]]),
    ),
    ...extra,
  };
}
function temporary(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'watchtower-deployment-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}
function save(path, env) {
  writeFileSync(
    path,
    `${Object.entries(env)
      .map(([key, value]) => dotenvLine(key, value))
      .join('\n')}\n`,
    { mode: 0o600 },
  );
}
function configure(cwd, extra = {}) {
  return spawnSync(process.execPath, [join(root, 'deploy/vm/configure.mjs')], {
    cwd,
    env: environment({ WATCHTOWER_ENV_FILE: join(cwd, 'app.env'), ...extra }),
    encoding: 'utf8',
    timeout: 30000,
  });
}
function succeed(result) {
  assert.equal(result.status, 0, result.stderr);
}

test('VM setup generates restricted database inputs and preserves credentials while updating the public URL', (t) => {
  const cwd = temporary(t);
  const path = join(cwd, 'app.env');
  save(path, {
    ...base,
    DATABASE_URL: '',
    COMPOSE_PROFILES: 'bundled-db,https',
    WATCHTOWER_DOMAIN: 'fixture.example',
    TELEGRAM_API_ID: '12345',
    TELEGRAM_API_HASH: 'a'.repeat(32),
    TELEGRAM_SESSION_KEY: 'b'.repeat(64),
  });
  const first = configure(cwd);
  succeed(first);
  const input = parseEnv(readFileSync(path, 'utf8'));
  const runtimePath = join(cwd, '.watchtower/runtime.env');
  const runtime = parseEnv(readFileSync(runtimePath, 'utf8'));
  const compose = parseEnv(readFileSync(join(cwd, '.watchtower/compose.env'), 'utf8'));
  const connection = new URL(runtime.DATABASE_URL);
  assert.equal(connection.hostname, 'db');
  assert.equal(connection.username, 'watchtower');
  assert.equal(decodeURIComponent(connection.password), input.WATCHTOWER_DATABASE_PASSWORD);
  assert.notEqual(input.POSTGRES_PASSWORD, input.WATCHTOWER_DATABASE_PASSWORD);
  assert.equal(runtime.DATABASE_SSL_MODE, 'disable');
  assert.equal(runtime.DATABASE_ROOT_CHAT_ID, base.TELEGRAM_CHAT_ID);
  assert.equal(compose.COMPOSE_PROFILES, 'bundled-db,https');
  assert.equal(compose.POSTGRES_PASSWORD, input.POSTGRES_PASSWORD);
  assert.equal(runtime.POSTGRES_PASSWORD, undefined);
  assert.equal(runtime.WATCHTOWER_DATABASE_PASSWORD, undefined);
  for (const secret of [input.POSTGRES_PASSWORD, connection.password, runtime.BROWSER_AUTH_TOKEN])
    assert.ok(!`${first.stdout}${first.stderr}`.includes(secret));
  for (const output of [path, runtimePath, join(cwd, '.watchtower/compose.env')])
    assert.equal(statSync(output).mode & 0o777, 0o600);
  save(path, {
    ...input,
    PUBLIC_URL: 'https://updated.example',
    WATCHTOWER_DOMAIN: 'updated.example',
  });
  succeed(configure(cwd));
  const updatedInput = parseEnv(readFileSync(path, 'utf8'));
  const updated = parseEnv(readFileSync(runtimePath, 'utf8'));
  assert.equal(updated.PUBLIC_URL, 'https://updated.example');
  for (const key of [
    'DATABASE_URL',
    'DATABASE_ROOT_CHAT_ID',
    'TELEGRAM_WEBHOOK_SECRET',
    'BROWSER_AUTH_TOKEN',
    'CRON_SECRET',
    'TELEGRAM_SESSION_KEY',
  ])
    assert.equal(updated[key], runtime[key]);
  assert.equal(updatedInput.POSTGRES_PASSWORD, input.POSTGRES_PASSWORD);
  assert.equal(updatedInput.WATCHTOWER_DATABASE_PASSWORD, input.WATCHTOWER_DATABASE_PASSWORD);
});

test('VM setup refuses unsafe profile combinations before writing deployment outputs', (t) => {
  const cwd = temporary(t);
  const cases = [
    [{ COMPOSE_PROFILES: 'bundled-db' }, /watchtower@db/],
    [
      { COMPOSE_PROFILES: 'bundled-db', DATABASE_URL: '', DATABASE_SSL_MODE: 'verify-full' },
      /DATABASE_SSL_MODE=disable/,
    ],
    [
      { COMPOSE_PROFILES: 'bundled-db', DATABASE_URL: '', DATABASE_ADMIN_URL: base.DATABASE_URL },
      /Remove DATABASE_ADMIN_URL/,
    ],
    [{ COMPOSE_PROFILES: 'https', WATCHTOWER_DOMAIN: 'different.example' }, /PUBLIC_URL=https/],
    [{ COMPOSE_PROFILES: 'unexpected' }, /COMPOSE_PROFILES/],
  ];
  for (const [input, pattern] of cases) {
    save(join(cwd, 'app.env'), { ...base, ...input });
    const result = configure(cwd);
    assert.equal(result.status, 1);
    assert.match(result.stderr, pattern);
    assert.equal(existsSync(join(cwd, '.watchtower/runtime.env')), false);
  }
});

const dockerCompose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
test(
  'Compose validates every profile without requiring inactive profile inputs',
  { skip: dockerCompose.status !== 0 && 'Docker Compose CLI unavailable' },
  (t) => {
    const cwd = temporary(t);
    const cases = ['', 'https', 'bundled-db', 'bundled-db,https'].map((profiles) => [profiles, '']);
    cases.push(['', '::1']);
    for (const [profiles, bind] of cases) {
      save(join(cwd, 'app.env'), {
        ...base,
        ...(profiles.includes('bundled-db') ? { DATABASE_URL: '' } : {}),
        COMPOSE_PROFILES: profiles,
        ...(bind ? { WATCHTOWER_BIND: bind } : {}),
        ...(profiles.includes('https') ? { WATCHTOWER_DOMAIN: 'fixture.example' } : {}),
      });
      succeed(configure(cwd));
      const result = spawnSync(
        'docker',
        [
          'compose',
          '--project-directory',
          cwd,
          '-f',
          join(root, 'docker-compose.yml'),
          '--env-file',
          join(cwd, '.watchtower/compose.env'),
          'config',
          '--format',
          'json',
        ],
        { cwd, env: environment(), encoding: 'utf8', timeout: 30000 },
      );
      succeed(result);
      const services = JSON.parse(result.stdout).services;
      assert.equal(services.watchtower.ports[0].host_ip, bind || '127.0.0.1');
      assert.equal(Boolean(services.db), profiles.includes('bundled-db'));
      assert.equal(Boolean(services.caddy), profiles.includes('https'));
    }
  },
);

function installerFixture(t) {
  const cwd = temporary(t);
  mkdirSync(join(cwd, 'deploy/vm'), { recursive: true });
  copyFileSync(join(root, 'deploy/vm/install.sh'), join(cwd, 'deploy/vm/install.sh'));
  mkdirSync(join(cwd, 'bin'));
  const log = join(cwd, 'docker-calls.jsonl');
  writeFileSync(
    join(cwd, 'bin/docker'),
    `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.MOCK_DOCKER_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'run') {
  const envFile = args.find(a => a.startsWith('WATCHTOWER_ENV_FILE=')).slice('WATCHTOWER_ENV_FILE='.length);
  // Real docker run forwards only the explicitly selected environment file.
  const result = cp.spawnSync(process.execPath, [${JSON.stringify(join(root, 'deploy/vm/configure.mjs'))}], { stdio: 'inherit', env: { PATH: process.env.PATH, HOME: process.env.HOME, WATCHTOWER_ENV_FILE: envFile } });
  process.exit(result.status);
}
if (args[0] === 'compose' && args.includes('--env-file') && process.env.MOCK_COMPOSE_PROBE) {
  const overrides = ['COMPOSE_FILE', 'COMPOSE_ENV_FILES', 'COMPOSE_PROFILES', 'POSTGRES_PASSWORD', 'WATCHTOWER_DATABASE_PASSWORD', 'WATCHTOWER_BIND', 'WATCHTOWER_PORT', 'WATCHTOWER_DOMAIN'].filter(key => process.env[key] !== undefined);
  fs.writeFileSync(process.env.MOCK_COMPOSE_PROBE, JSON.stringify({ overrides, project: process.env.COMPOSE_PROJECT_NAME, dockerHost: process.env.DOCKER_HOST, dockerConfig: process.env.DOCKER_CONFIG }));
  if (args.includes('--quiet') && process.env.MOCK_REAL_DOCKER) {
    const result = cp.spawnSync(process.env.MOCK_REAL_DOCKER, [...args.filter(arg => arg !== '--quiet'), '--format', 'json'], { encoding: 'utf8', env: process.env });
    if (result.status !== 0) { console.error(result.stderr); process.exit(result.status || 1); }
    fs.writeFileSync(process.env.MOCK_COMPOSE_PROBE + '.config', result.stdout, { mode: 0o600 });
  }
}
if (args.includes('--services')) console.log('watchtower\\ndb');
if (args.includes('run') && process.env.MOCK_BOOTSTRAP_FAILURE === '1') process.exit(7);
`,
    { mode: 0o755 },
  );
  save(join(cwd, 'app.env'), { ...base, DATABASE_URL: '', COMPOSE_PROFILES: 'bundled-db' });
  return { cwd, log };
}
function install(cwd, extra = {}) {
  return spawnSync('sh', [join(cwd, 'deploy/vm/install.sh')], {
    cwd: tmpdir(),
    env: environment({
      PATH: `${join(cwd, 'bin')}:${process.env.PATH}`,
      MOCK_DOCKER_LOG: join(cwd, 'docker-calls.jsonl'),
      ...extra,
    }),
    encoding: 'utf8',
    timeout: 30000,
  });
}
test('VM installer uses its repository path and initializes the database before starting the app', (t) => {
  const { cwd, log } = installerFixture(t);
  succeed(install(cwd));
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  const database = calls.findIndex((args) => args.includes('up') && args.at(-1) === 'db');
  const bootstrap = calls.findIndex((args) => args.includes('scripts/database-setup.ts'));
  const start = calls.findIndex((args) => args.includes('up') && args.at(-1) === '--wait');
  assert.ok(database > 0 && bootstrap > database && start > bootstrap);
  // A root-created 0600 app.env must be readable on a real Linux bind mount.
  assert.equal(calls[bootstrap][calls[bootstrap].indexOf('--user') + 1], '0:0');
  assert.ok(
    calls[bootstrap].includes(
      `${realpathSync(join(cwd, 'app.env'))}:/run/watchtower-bootstrap.env:ro`,
    ),
  );
  assert.equal(
    calls
      .filter((args) => args.includes('compose') && !args.includes('version'))
      .every((args) => args.includes('.watchtower/compose.env')),
    true,
  );
});
test('VM installer leaves the app stopped when database initialization fails', (t) => {
  const { cwd, log } = installerFixture(t);
  const result = install(cwd, { MOCK_BOOTSTRAP_FAILURE: '1' });
  assert.equal(result.status, 7);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.some((args) => args.includes('scripts/database-setup.ts')));
  assert.equal(
    calls.some((args) => args.includes('up') && args.at(-1) === '--wait'),
    false,
  );
});
test('VM installer honors the shared environment selector and its explicit VM override', (t) => {
  for (const override of [false, true]) {
    const { cwd, log } = installerFixture(t);
    const selected = join(cwd, override ? 'vm-input.env' : 'shared-input.env');
    save(selected, { ...base, TELEGRAM_CHAT_ID: '-1005555555555' });
    succeed(
      install(cwd, {
        WATCHTOWER_ENV_FILE: override ? 'missing-unused-input.env' : selected,
        ...(override ? { WATCHTOWER_VM_ENV: selected } : {}),
      }),
    );
    const runtime = parseEnv(readFileSync(join(cwd, '.watchtower/runtime.env'), 'utf8'));
    assert.equal(runtime.TELEGRAM_CHAT_ID, '-1005555555555');
    assert.equal(
      parseEnv(readFileSync(join(cwd, 'app.env'), 'utf8')).BROWSER_AUTH_TOKEN,
      undefined,
    );
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    const bootstrap = calls.find((args) => args.includes('scripts/database-setup.ts'));
    assert.ok(bootstrap.includes(`${realpathSync(selected)}:/run/watchtower-bootstrap.env:ro`));
  }
});
test('VM installer deploys private inputs despite conflicting shell exports and preserves Docker context', (t) => {
  const { cwd } = installerFixture(t);
  copyFileSync(join(root, 'docker-compose.yml'), join(cwd, 'docker-compose.yml'));
  const realDocker = spawnSync('sh', ['-c', 'command -v docker'], {
    encoding: 'utf8',
  }).stdout.trim();
  const probe = join(cwd, 'compose-environment.json');
  const dockerHost = 'unix:///tmp/watchtower-fixture-no-daemon.sock';
  const dockerConfig = process.env.DOCKER_CONFIG || join(process.env.HOME || cwd, '.docker');
  succeed(
    install(cwd, {
      COMPOSE_FILE: 'some-other-project.yml',
      COMPOSE_ENV_FILES: 'some-other-input.env',
      COMPOSE_PROFILES: 'https',
      POSTGRES_PASSWORD: 'conflicting-admin-password',
      WATCHTOWER_DATABASE_PASSWORD: 'conflicting-runtime-password',
      WATCHTOWER_BIND: '0.0.0.0',
      WATCHTOWER_PORT: '9999',
      WATCHTOWER_DOMAIN: 'conflicting.example',
      COMPOSE_PROJECT_NAME: 'fixture-isolated-project',
      DOCKER_HOST: dockerHost,
      DOCKER_CONFIG: dockerConfig,
      MOCK_COMPOSE_PROBE: probe,
      ...(dockerCompose.status === 0 ? { MOCK_REAL_DOCKER: realDocker } : {}),
    }),
  );
  const received = JSON.parse(readFileSync(probe, 'utf8'));
  assert.deepEqual(received.overrides, []);
  assert.equal(received.project, 'fixture-isolated-project');
  assert.equal(received.dockerHost, dockerHost);
  assert.equal(received.dockerConfig, dockerConfig);
  if (dockerCompose.status === 0) {
    const input = parseEnv(readFileSync(join(cwd, 'app.env'), 'utf8'));
    const checked = JSON.parse(readFileSync(`${probe}.config`, 'utf8'));
    assert.equal(checked.services.db.environment.POSTGRES_PASSWORD, input.POSTGRES_PASSWORD);
    assert.equal(
      checked.services.db.environment.WATCHTOWER_DATABASE_PASSWORD,
      input.WATCHTOWER_DATABASE_PASSWORD,
    );
    assert.equal(checked.services.watchtower.ports[0].host_ip, '127.0.0.1');
    assert.equal(checked.services.watchtower.ports[0].published, '3000');
    assert.equal(Boolean(checked.services.caddy), false);
  }
});
test('VM installer refuses an unignored custom input before invoking Docker', (t) => {
  const { cwd, log } = installerFixture(t);
  succeed(spawnSync('git', ['init', '-q'], { cwd, encoding: 'utf8' }));
  copyFileSync(join(root, '.gitignore'), join(cwd, '.gitignore'));
  save(join(cwd, 'unignored-input'), base);
  const result = install(cwd, { WATCHTOWER_VM_ENV: 'unignored-input' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not ignored by Git/);
  assert.equal(existsSync(log), false);
});

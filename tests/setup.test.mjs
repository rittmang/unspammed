import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { test } from 'node:test';
import { loadEnvironment, canonicalEnvironment } from '../scripts/setup-env.mjs';
import {
  generatedEnvironment,
  validateConfiguration,
  validatePublicOrigin,
  writeSetupOutputs,
  saveEnvironmentDefaults,
  dotenvLine,
  safeErrorMessage,
  assertPrivatePaths,
  writePrivate,
  readCloudflareConfiguration,
} from '../scripts/setup-lib.mjs';
import { prepareDevEnvironment } from '../scripts/dev-env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = {
  DEV_MODE: 'false',
  DATABASE_BACKEND: 'postgres',
  PUBLIC_URL: 'https://install.example',
  DATABASE_URL: 'postgres://app:fixture-password@database.example/watchtower',
  TELEGRAM_BOT_TOKEN: '987654321:FAKE_FIXTURE_TOKEN_NEVER_CONTACT_TELEGRAM',
  TELEGRAM_CHAT_ID: '-1009876543210',
  OWNER_TELEGRAM_ID: '234567890',
  TELEGRAM_BOT_USERNAME: 'fixture_owner_bot',
  WATCHTOWER_NAME: 'fixture-install',
  CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32),
};
const isolatedEnv = () =>
  Object.fromEntries(
    ['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT']
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
function temporary(t) {
  const path = mkdtempSync(join(tmpdir(), 'watchtower-setup-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function save(path, env) {
  writeFileSync(
    path,
    Object.entries(env)
      .map(([key, value]) => dotenvLine(key, value))
      .join('\n') + '\n',
    { mode: 0o600 },
  );
}
function cli(cwd, script, args = [], env = {}) {
  return spawnSync(process.execPath, [join(root, 'scripts', script), ...args], {
    cwd,
    env: { ...isolatedEnv(), ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
}
function succeed(result) {
  assert.equal(result.status, 0, result.stderr);
}
function fail(result, pattern) {
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, pattern);
}

test('environment selection is explicit, process-first, and compatible with legacy aliases', (t) => {
  const cwd = temporary(t);
  save(join(cwd, '.dev.vars'), {
    OWNER_TELEGRAM_ID: '111',
    WORKER_URL: base.PUBLIC_URL,
    PLANETSCALE_DATABASE_URL: base.DATABASE_URL,
  });
  let loaded = loadEnvironment({ cwd, env: {} });
  assert.equal(loaded.path, join(cwd, '.dev.vars'));
  assert.equal(canonicalEnvironment(loaded.env).DATABASE_URL, base.DATABASE_URL);
  save(join(cwd, '.env'), { OWNER_TELEGRAM_ID: '222' });
  loaded = loadEnvironment({ cwd, env: { OWNER_TELEGRAM_ID: '333' } });
  assert.equal(loaded.env.OWNER_TELEGRAM_ID, '333');
  assert.equal(loaded.path, join(cwd, '.env'));
  assert.throws(
    () => loadEnvironment({ cwd, env: { WATCHTOWER_ENV_FILE: 'missing.env' } }),
    /does not exist/,
  );
  save(join(cwd, 'separate.env'), { OWNER_TELEGRAM_ID: '444' });
  assert.equal(
    loadEnvironment({ cwd, env: { WATCHTOWER_ENV_FILE: 'separate.env' } }).env.OWNER_TELEGRAM_ID,
    '444',
  );
});

test('each hosting setup path uses supplied identities and preserves generated credentials on rerun', (t) => {
  const cwd = temporary(t);
  for (const provider of ['cloudflare', 'railway', 'digitalocean', 'vercel', 'render', 'fly']) {
    const directory = join(cwd, provider);
    mkdirSync(directory);
    save(join(directory, '.env'), {
      ...base,
      DATABASE_ADMIN_URL: 'postgres://admin:private-admin@database.example/watchtower',
      CLOUDFLARE_API_TOKEN: 'PRIVATE_PROVIDER_TOKEN',
    });
    const args = ['--provider', provider, '--browser-auth'];
    const first = cli(directory, 'setup.mjs', args);
    succeed(first);
    const runtimePath = join(directory, '.watchtower/runtime.env');
    const before = readFileSync(runtimePath, 'utf8');
    const generated = parseEnv(before);
    assert.equal(generated.OWNER_TELEGRAM_ID, base.OWNER_TELEGRAM_ID);
    assert.equal(generated.TELEGRAM_CHAT_ID, base.TELEGRAM_CHAT_ID);
    assert.equal(generated.DATABASE_ROOT_CHAT_ID, base.TELEGRAM_CHAT_ID);
    assert.equal(generated.DEV_MODE, 'false');
    assert.equal(generated.DATABASE_SSL_MODE, 'verify-full');
    assert.match(generated.BROWSER_AUTH_TOKEN, /^[A-Za-z0-9_-]{43}$/);
    assert.match(generated.TELEGRAM_WEBHOOK_SECRET, /^[A-Za-z0-9_-]{43}$/);
    assert.match(generated.CRON_SECRET, /^[A-Za-z0-9_-]{43}$/);
    assert(!before.includes('private-admin') && !before.includes('PRIVATE_PROVIDER_TOKEN'));
    for (const path of [
      runtimePath,
      join(directory, '.env'),
      join(directory, '.watchtower/secrets.json'),
    ])
      assert.equal(statSync(path).mode & 0o777, 0o600);
    const secretOutput = first.stdout + first.stderr;
    for (const value of [
      base.TELEGRAM_BOT_TOKEN,
      base.DATABASE_URL,
      generated.BROWSER_AUTH_TOKEN,
      generated.TELEGRAM_WEBHOOK_SECRET,
    ])
      assert(!secretOutput.includes(value));
    succeed(cli(directory, 'setup.mjs', args));
    assert.equal(readFileSync(runtimePath, 'utf8'), before);
    const envBefore = readFileSync(join(directory, '.env'), 'utf8');
    succeed(cli(directory, 'setup.mjs', ['--doctor']));
    assert.equal(
      readFileSync(join(directory, '.env'), 'utf8'),
      envBefore,
      'doctor must not change credentials',
    );
    if (provider === 'cloudflare') {
      const config = JSON.parse(readFileSync(join(directory, 'wrangler.generated.jsonc'), 'utf8'));
      assert.equal(config.account_id, base.CLOUDFLARE_ACCOUNT_ID);
      assert.equal(config.name, base.WATCHTOWER_NAME);
      assert.equal(config.vars.OWNER_TELEGRAM_ID, base.OWNER_TELEGRAM_ID);
      assert.equal(config.workers_dev, true);
      assert(!config.hyperdrive && !config.routes);
      const serialized = JSON.stringify(config);
      for (const value of [
        base.TELEGRAM_BOT_TOKEN,
        base.DATABASE_URL,
        generated.BROWSER_AUTH_TOKEN,
      ])
        assert(!serialized.includes(value));
    } else assert(!existsSync(join(directory, 'wrangler.generated.jsonc')));
  }
});

test('incomplete setup saves private work but never invents an owner, group, or hosting account', (t) => {
  const cwd = temporary(t);
  fail(cli(cwd, 'setup.mjs', ['--provider', 'cloudflare']), /Set OWNER_TELEGRAM_ID/);
  const saved = parseEnv(readFileSync(join(cwd, '.env'), 'utf8'));
  assert(saved.TELEGRAM_WEBHOOK_SECRET && saved.CRON_SECRET);
  for (const key of ['OWNER_TELEGRAM_ID', 'TELEGRAM_CHAT_ID', 'CLOUDFLARE_ACCOUNT_ID'])
    assert(!saved[key]);
  assert(!existsSync(join(cwd, '.watchtower/runtime.env')));
  const before = readFileSync(join(cwd, '.env'), 'utf8');
  fail(cli(cwd, 'setup.mjs', ['--doctor']), /Set OWNER_TELEGRAM_ID/);
  assert.equal(readFileSync(join(cwd, '.env'), 'utf8'), before);
});

test('setup preserves installed browser/admin/webhook secrets and pins the original database namespace', (t) => {
  const cwd = temporary(t);
  const existing = {
    ...base,
    DEV_MODE: 'true',
    DATABASE_BACKEND: 'sqlite',
    WATCHTOWER_PROVIDER: 'railway',
    BROWSER_AUTH_TOKEN: 'x'.repeat(43),
    TELEGRAM_WEBHOOK_SECRET: 'y'.repeat(43),
    CRON_SECRET: 'z'.repeat(43),
    TELEGRAM_API_ID: '12345',
    TELEGRAM_API_HASH: 'a'.repeat(32),
    TELEGRAM_SESSION_KEY: 'c'.repeat(64),
  };
  save(join(cwd, '.env'), existing);
  succeed(cli(cwd, 'setup.mjs', ['--provider', 'vercel', '--browser-auth']));
  let saved = parseEnv(readFileSync(join(cwd, '.env'), 'utf8'));
  assert.equal(saved.DEV_MODE, 'false');
  assert.equal(saved.DATABASE_BACKEND, 'postgres');
  assert.equal(saved.WATCHTOWER_PROVIDER, 'vercel');
  for (const key of [
    'BROWSER_AUTH_TOKEN',
    'TELEGRAM_WEBHOOK_SECRET',
    'CRON_SECRET',
    'TELEGRAM_SESSION_KEY',
  ])
    assert.equal(saved[key], existing[key]);
  saved.TELEGRAM_CHAT_ID = '-1005555555555';
  save(join(cwd, '.env'), saved);
  fail(cli(cwd, 'setup.mjs', ['--provider', 'vercel']), /Refusing to replace/);
  succeed(cli(cwd, 'setup.mjs', ['--provider', 'vercel', '--force']));
  saved = parseEnv(readFileSync(join(cwd, '.watchtower/runtime.env'), 'utf8'));
  assert.equal(saved.DATABASE_ROOT_CHAT_ID, base.TELEGRAM_CHAT_ID);
  assert.equal(saved.TELEGRAM_CHAT_ID, '-1005555555555');
  assert.equal(saved.TELEGRAM_SESSION_KEY, existing.TELEGRAM_SESSION_KEY);
});

test('legacy-only setup migrates aliases without editing its input file', (t) => {
  const cwd = temporary(t);
  const { PUBLIC_URL, DATABASE_URL, ...values } = base;
  save(join(cwd, '.dev.vars'), {
    ...values,
    WORKER_URL: PUBLIC_URL,
    PLANETSCALE_DATABASE_URL: DATABASE_URL,
  });
  const previous = readFileSync(join(cwd, '.dev.vars'), 'utf8');
  succeed(cli(cwd, 'setup.mjs', ['--provider', 'railway']));
  assert.equal(readFileSync(join(cwd, '.dev.vars'), 'utf8'), previous);
  const runtime = parseEnv(readFileSync(join(cwd, '.watchtower/runtime.env'), 'utf8'));
  assert.equal(runtime.PUBLIC_URL, PUBLIC_URL);
  assert.equal(runtime.DATABASE_URL, DATABASE_URL);
});

test('private paths must be untracked and ignored before setup generates credentials', (t) => {
  const cwd = temporary(t);
  succeed(spawnSync('git', ['init', '--quiet'], { cwd, encoding: 'utf8' }));
  const ignored = '.env\n.watchtower/\nwrangler.generated.jsonc\n.tmp/\n';
  writeFileSync(join(cwd, '.gitignore'), ignored);
  save(join(cwd, 'credentials.vars'), base);
  const previous = readFileSync(join(cwd, 'credentials.vars'), 'utf8');
  fail(
    cli(cwd, 'setup.mjs', ['--provider', 'railway'], { WATCHTOWER_ENV_FILE: 'credentials.vars' }),
    /not ignored by Git/,
  );
  assert.equal(readFileSync(join(cwd, 'credentials.vars'), 'utf8'), previous);
  assert(!existsSync(join(cwd, '.watchtower')));
  writeFileSync(join(cwd, '.gitignore'), ignored + 'credentials.vars\n');
  succeed(
    cli(cwd, 'setup.mjs', ['--provider', 'railway'], { WATCHTOWER_ENV_FILE: 'credentials.vars' }),
  );
  succeed(spawnSync('git', ['add', '-f', 'credentials.vars'], { cwd, encoding: 'utf8' }));
  assert.throws(() => assertPrivatePaths(cwd, ['credentials.vars']), /tracked/);
});

test('dotenv values round-trip multiline certificates, backslashes, JSON, and empty placeholders', (t) => {
  const cwd = temporary(t);
  const path = join(cwd, '.env');
  writeFileSync(path, "# Keep this comment\nTELEGRAM_BOT_TOKEN=\nBROWSER_AUTH_TOKEN=''\n");
  const values = {
    TELEGRAM_BOT_TOKEN: base.TELEGRAM_BOT_TOKEN,
    BROWSER_AUTH_TOKEN: 'x'.repeat(43),
    DATABASE_SSL_CA: '-----BEGIN CERTIFICATE-----\nfixture\\certificate\n-----END CERTIFICATE-----',
    MODEL_PROVIDERS_JSON: '[{"id":"sample","apiKeyEnv":"CUSTOM_API_KEY"}]',
  };
  saveEnvironmentDefaults(path, values);
  const saved = readFileSync(path, 'utf8');
  assert(saved.includes('# Keep this comment'));
  const parsed = parseEnv(saved);
  for (const [key, value] of Object.entries(values)) assert.equal(parsed[key], value);
  saveEnvironmentDefaults(path, { BROWSER_AUTH_TOKEN: 'y'.repeat(43) });
  assert.equal(parseEnv(readFileSync(path, 'utf8')).BROWSER_AUTH_TOKEN, values.BROWSER_AUTH_TOKEN);
});

test('output conflict preflight leaves all previous derived files intact', (t) => {
  const cwd = temporary(t);
  const env = generatedEnvironment(base, 'cloudflare', true);
  writeSetupOutputs(cwd, env, 'cloudflare');
  const runtimePath = join(cwd, '.watchtower/runtime.env');
  const before = readFileSync(runtimePath, 'utf8');
  const configPath = join(cwd, 'wrangler.generated.jsonc');
  const config = readFileSync(configPath, 'utf8');
  assert.throws(
    () => writeSetupOutputs(cwd, { ...env, PUBLIC_URL: 'https://changed.example' }, 'cloudflare'),
    /Refusing to replace/,
  );
  assert.equal(readFileSync(runtimePath, 'utf8'), before);
  assert.equal(readFileSync(configPath, 'utf8'), config);
  const target = join(cwd, 'target');
  writeFileSync(target, 'keep');
  const link = join(cwd, 'link');
  symlinkSync(target, link);
  assert.throws(() => writePrivate(link, 'replace', { force: true }), /symbolic link/);
  assert.equal(readFileSync(target, 'utf8'), 'keep');
});

test('hosted configuration rejects malformed identities, weak secrets, partial Access/admin config, and invalid TLS', () => {
  const valid = generatedEnvironment(base, 'cloudflare', true);
  assert.deepEqual(validateConfiguration(valid, 'cloudflare').errors, []);
  for (const changes of [
    { OWNER_TELEGRAM_ID: '9007199254740993' },
    { TELEGRAM_CHAT_ID: '-12345' },
    { DATABASE_ROOT_CHAT_ID: '123' },
    { TELEGRAM_BOT_TOKEN: 'not-a-token' },
    { TELEGRAM_BOT_USERNAME: '@another_bot' },
    { BROWSER_AUTH_TOKEN: 'short' },
    { TELEGRAM_WEBHOOK_SECRET: 'short' },
    { CRON_SECRET: 'short' },
    { DATABASE_URL: 'mysql://user:pass@database.example/db' },
    { DATABASE_URL: 'postgres://app:pass@database.example/db#unsafe' },
    { DATABASE_SSL_MODE: 'require' },
    { DATABASE_URL: 'postgres://app@127.0.0.1/db' },
    { DATABASE_SSL_MODE: 'disable', DATABASE_SSL_CA: 'certificate' },
    { DATABASE_SSL_CA: 'custom-private-ca' },
    { ACCESS_AUD: 'incomplete' },
    { TELEGRAM_API_ID: '12345' },
    { CLOUDFLARE_ACCOUNT_ID: '' },
    { CLOUDFLARE_CUSTOM_DOMAIN: 'install.example/' },
    { HYPERDRIVE_ID: 'not-own-id' },
  ])
    assert(
      validateConfiguration({ ...valid, ...changes }, 'cloudflare').errors.length > 0,
      JSON.stringify(changes),
    );
  assert.deepEqual(
    validateConfiguration(
      { ...valid, DATABASE_URL: 'postgres://app@127.0.0.1/db', DATABASE_SSL_MODE: 'disable' },
      'cloudflare',
    ).errors,
    [],
  );
});

test('public origin validation blocks private/local addresses and URL credential channels', () => {
  for (const origin of [
    'http://install.example',
    'https://user:password@install.example',
    'https://install.example/path',
    'https://install.example/?token=secret',
    'https://localhost',
    'https://127.0.0.1',
    'https://[::1]',
    'https://[fd00::1]',
    'https://10.0.0.1',
    'https://100.64.0.1',
    'https://app.internal',
    'https://install.example:8443',
  ])
    assert.throws(() => validatePublicOrigin(origin), /public HTTPS/);
  assert.equal(validatePublicOrigin('https://install.example/'), 'https://install.example');
});

test('error formatting redacts database URLs, bot tokens, and installed application secrets', () => {
  const env = generatedEnvironment(base, 'railway', true);
  const message = safeErrorMessage(
    new Error(
      `Request https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe ${env.DATABASE_URL} ${env.BROWSER_AUTH_TOKEN}`,
    ),
    env,
  );
  assert(!message.includes(env.TELEGRAM_BOT_TOKEN));
  assert(!message.includes('fixture-password'));
  assert(!message.includes(env.BROWSER_AUTH_TOKEN));
});

test('deploy check rejects stale generated public vars and unconfigured starter without executing provider commands', (t) => {
  const cwd = temporary(t);
  save(join(cwd, '.env'), base);
  succeed(cli(cwd, 'setup.mjs', ['--provider', 'cloudflare']));
  succeed(cli(cwd, 'deploy.mjs', ['--check']));
  const path = join(cwd, 'wrangler.generated.jsonc');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  config.vars.OWNER_TELEGRAM_ID = '999999';
  writeFileSync(path, JSON.stringify(config));
  fail(cli(cwd, 'deploy.mjs', ['--check']), /does not match/);
  writeFileSync(path, '{"name":"watchtower-unconfigured"}');
  fail(cli(cwd, 'deploy.mjs', ['--check', '--config', path]), /unconfigured starter/);
});

test('JSONC parsing preserves comment-looking and comma-looking text inside string values', (t) => {
  const cwd = temporary(t);
  const path = join(cwd, 'config.jsonc');
  writeFileSync(
    path,
    '{\n// comment\n"name": "own-worker",\n"vars": {"PUBLIC_URL": "https://install.example", "literal": "value,} //keep",}, /* block */\n}',
  );
  const config = readCloudflareConfiguration(path);
  assert.equal(config.vars.PUBLIC_URL, base.PUBLIC_URL);
  assert.equal(config.vars.literal, 'value,} //keep');
});

test('CLI option mistakes fail before writing credentials', (t) => {
  const cwd = temporary(t);
  for (const args of [
    ['--provider'],
    ['--provider', '--browser-auth'],
    ['--provider', 'railway', '--provider', 'vercel'],
    ['--token', 'private'],
  ])
    fail(cli(cwd, 'setup.mjs', args), /Usage/);
  fail(cli(cwd, 'deploy.mjs', ['--config', '--check']), /Usage/);
  fail(cli(cwd, 'telegram-admin-configure.mjs', ['--config']), /Usage/);
  assert(!existsSync(join(cwd, '.env')));
});

test('local development ignores installed credentials unless an explicit test env is selected', (t) => {
  const cwd = temporary(t);
  writeFileSync(join(cwd, '.dev.vars.example'), readFileSync(join(root, '.dev.vars.example')));
  save(join(cwd, '.env'), { ...base, BROWSER_AUTH_TOKEN: 'PRIVATE_BROWSER' });
  save(join(cwd, '.dev.vars'), { TELEGRAM_BOT_TOKEN: 'PRIVATE_LEGACY_BOT' });
  const before = readFileSync(join(cwd, '.env'), 'utf8');
  let result = prepareDevEnvironment({
    cwd,
    env: { ...base, BROWSER_AUTH_TOKEN: 'SHELL_PRIVATE', CLOUDFLARE_API_TOKEN: 'PROVIDER_PRIVATE' },
  });
  let vars = parseEnv(readFileSync(result.path, 'utf8'));
  assert.equal(vars.TELEGRAM_BOT_TOKEN, '');
  assert.equal(vars.DEV_MODE, 'true');
  assert.equal(vars.DATABASE_BACKEND, 'sqlite');
  for (const key of [
    'DATABASE_URL',
    'BROWSER_AUTH_TOKEN',
    'OWNER_TELEGRAM_ID',
    'TELEGRAM_BOT_TOKEN',
  ])
    assert(!result.childEnv[key]);
  assert.equal(readFileSync(join(cwd, '.env'), 'utf8'), before);
  save(join(cwd, 'test.env'), { ...base, BROWSER_AUTH_TOKEN: 'test-browser' });
  result = prepareDevEnvironment({ cwd, env: { WATCHTOWER_ENV_FILE: 'test.env' } });
  vars = parseEnv(readFileSync(result.path, 'utf8'));
  assert.equal(vars.TELEGRAM_BOT_TOKEN, base.TELEGRAM_BOT_TOKEN);
  assert(!vars.BROWSER_AUTH_TOKEN && !vars.DATABASE_URL);
  assert.equal(result.explicit, true);
});

test('optional admin setup refuses implicit session-key rotation and preserves existing encryption keys', (t) => {
  const cwd = temporary(t);
  const env = { TELEGRAM_API_ID: '123456', TELEGRAM_API_HASH: 'a'.repeat(32) };
  save(join(cwd, '.env'), env);
  fail(cli(cwd, 'telegram-admin-configure.mjs'), /Restore TELEGRAM_SESSION_KEY/);
  succeed(cli(cwd, 'telegram-admin-configure.mjs', ['--provider', 'railway', '--new-session-key']));
  const first = parseEnv(readFileSync(join(cwd, '.env'), 'utf8'));
  assert.match(first.TELEGRAM_SESSION_KEY, /^[a-f0-9]{64}$/);
  succeed(cli(cwd, 'telegram-admin-configure.mjs', ['--new-session-key']));
  const next = JSON.parse(readFileSync(join(cwd, '.watchtower/admin-secrets.json'), 'utf8'));
  assert.equal(next.TELEGRAM_SESSION_KEY, first.TELEGRAM_SESSION_KEY);
  assert.equal(statSync(join(cwd, '.watchtower/admin-secrets.json')).mode & 0o777, 0o600);
});

test('custom model credentials are saved as private runtime secrets while reserved credential references are rejected', (t) => {
  const cwd = temporary(t);
  const custom = {
    ...base,
    MODEL_PROVIDERS_JSON: JSON.stringify([
      {
        id: 'fixture',
        name: 'Fixture',
        baseUrl: 'https://model.example/v1',
        apiKeyEnv: 'MY_PROVIDER_KEY',
        format: 'json_object',
      },
    ]),
    MY_PROVIDER_KEY: 'PRIVATE_MODEL_FIXTURE_KEY',
  };
  save(join(cwd, '.env'), custom);
  const result = cli(cwd, 'setup.mjs', ['--provider', 'cloudflare']);
  succeed(result);
  assert(!result.stdout.includes(custom.MY_PROVIDER_KEY));
  assert.equal(
    parseEnv(readFileSync(join(cwd, '.watchtower/runtime.env'), 'utf8')).MY_PROVIDER_KEY,
    custom.MY_PROVIDER_KEY,
  );
  assert.equal(
    JSON.parse(readFileSync(join(cwd, '.watchtower/secrets.json'), 'utf8')).MY_PROVIDER_KEY,
    custom.MY_PROVIDER_KEY,
  );
  assert(
    !readFileSync(join(cwd, 'wrangler.generated.jsonc'), 'utf8').includes(custom.MY_PROVIDER_KEY),
  );
  assert(
    !safeErrorMessage(new Error(custom.MY_PROVIDER_KEY), custom).includes(custom.MY_PROVIDER_KEY),
  );
  for (const key of [
    'DATABASE_ADMIN_URL',
    'CLOUDFLARE_API_TOKEN',
    'TELEGRAM_SESSION_KEY',
    'HOME',
    'VERCEL_TOKEN',
  ]) {
    const env = {
      ...generatedEnvironment(base, 'railway'),
      MODEL_PROVIDERS_JSON: JSON.stringify([{ apiKeyEnv: key }]),
    };
    assert(
      validateConfiguration(env, 'railway').errors.some((message) =>
        message.includes('dedicated uppercase model credential'),
      ),
    );
  }
});

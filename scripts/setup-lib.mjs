import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { isIP } from 'node:net';
import { parseEnv } from 'node:util';
import { canonicalEnvironment } from './setup-env.mjs';

export const providers = ['cloudflare', 'railway', 'digitalocean', 'vercel'];
export const publicKeys = [
  'DEV_MODE',
  'DATABASE_BACKEND',
  'PUBLIC_URL',
  'DASHBOARD_URL',
  'MINI_APP_URL',
  'TELEGRAM_CHAT_ID',
  'DATABASE_ROOT_CHAT_ID',
  'TELEGRAM_BOT_USERNAME',
  'OWNER_TELEGRAM_ID',
  'ADMIN_EMAIL',
  'ACCESS_TEAM_DOMAIN',
  'ACCESS_AUD',
  'DATABASE_SSL_MODE',
  'POLICY_DRAFT_MODEL',
];
export const secretKeys = [
  'DATABASE_URL',
  'DATABASE_SSL_CA',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_WEBHOOK_SECRET',
  'BROWSER_AUTH_TOKEN',
  'CRON_SECRET',
  'OPENROUTER_API_KEY',
  'MODEL_PROVIDERS_JSON',
  'CUSTOM_API_KEY',
  'TELEGRAM_API_ID',
  'TELEGRAM_API_HASH',
  'TELEGRAM_SESSION_KEY',
];
const localKeys = [
  'WATCHTOWER_PROVIDER',
  'WATCHTOWER_NAME',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_CUSTOM_DOMAIN',
  'HYPERDRIVE_ID',
  'DATABASE_ADMIN_URL',
  'DIGITALOCEAN_REPO',
  'DIGITALOCEAN_BRANCH',
  'DIGITALOCEAN_REGION',
  'TELEGRAM_WEBHOOK_IP',
];
export const environmentKeys = [...publicKeys, ...secretKeys, ...localKeys];

export function modelSecretKeys(env) {
  if (!env.MODEL_PROVIDERS_JSON) return [];
  let providers;
  try {
    providers = JSON.parse(env.MODEL_PROVIDERS_JSON);
  } catch {
    throw new Error('MODEL_PROVIDERS_JSON must be a JSON array.');
  }
  if (!Array.isArray(providers) || providers.length > 10)
    throw new Error('MODEL_PROVIDERS_JSON must contain at most ten providers.');
  return [
    ...new Set(
      providers.map((provider) => {
        const key = provider?.apiKeyEnv;
        const builtIn = ['OPENROUTER_API_KEY', 'CUSTOM_API_KEY'].includes(key);
        const reserved =
          environmentKeys.includes(key) ||
          /^(?:WATCHTOWER_|CLOUDFLARE_|CF_|RAILWAY_|DIGITALOCEAN_|DO_|VERCEL_|DATABASE_|PLANETSCALE_|TELEGRAM_|BROWSER_|CRON_|ACCESS_|AWS_|GITHUB_|NODE_|NPM_|HOME$|PATH$)/.test(
            key || '',
          );
        if (!/^[A-Z][A-Z0-9_]*$/.test(key || '') || (!builtIn && reserved))
          throw new Error(
            'Model apiKeyEnv must name a dedicated uppercase model credential, never an application, database, or hosting credential.',
          );
        return key;
      }),
    ),
  ];
}

function runtimeSecretKeys(env) {
  return [...new Set([...secretKeys, ...modelSecretKeys(env)])];
}

export function safeErrorMessage(error, env = process.env) {
  let message = String(error?.message || 'Operation failed.');
  let modelKeys = [];
  try {
    modelKeys = modelSecretKeys(env);
  } catch {
    /* Error reporting must work even with invalid provider JSON. */
  }
  for (const key of [
    ...secretKeys,
    ...modelKeys,
    ...Object.keys(env).filter((key) => /(?:_TOKEN|_SECRET|_PASSWORD|_API_KEY)$/.test(key)),
    'DATABASE_ADMIN_URL',
    'PLANETSCALE_DATABASE_URL',
    'PLANETSCALE_ADMIN_DATABASE_URL',
  ]) {
    const value = env[key];
    if (value) message = message.replaceAll(value, '[redacted]');
  }
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted database URL]')
    .replace(
      /https:\/\/api\.telegram\.org\/bot[^/\s]+/gi,
      'https://api.telegram.org/bot[redacted]',
    );
}

export function validatePublicOrigin(value, name = 'PUBLIC_URL') {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a public HTTPS origin.`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const privateIPv4 =
    /^(?:0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(
      host,
    );
  const privateIPv6 = isIP(host) === 6 && /^(?:::|fc|fd|fe[89ab])/i.test(host);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.port && url.port !== '443') ||
    privateIPv4 ||
    privateIPv6 ||
    host === 'localhost' ||
    (!host.includes('.') && isIP(host) !== 6) ||
    /\.(?:localhost|local|internal|invalid)$/.test(host)
  ) {
    throw new Error(`${name} must be a public HTTPS origin without a path, credentials, or query.`);
  }
  return url.origin;
}

export function validateConfiguration(input, provider, { requireGeneratedSecrets = true } = {}) {
  const env = canonicalEnvironment(input);
  const errors = [];
  try {
    modelSecretKeys(env);
  } catch (error) {
    errors.push(error.message);
  }
  const required = [
    'PUBLIC_URL',
    'DATABASE_URL',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'OWNER_TELEGRAM_ID',
  ];
  if (requireGeneratedSecrets) required.push('TELEGRAM_WEBHOOK_SECRET');
  for (const key of required) if (!env[key]) errors.push(`Set ${key}.`);
  for (const key of ['PUBLIC_URL', 'DASHBOARD_URL']) {
    if (env[key])
      try {
        validatePublicOrigin(env[key], key);
      } catch (error) {
        errors.push(error.message);
      }
  }
  if (env.MINI_APP_URL) {
    try {
      const mini = new URL(env.MINI_APP_URL);
      validatePublicOrigin(mini.origin, 'MINI_APP_URL');
      if (
        !['/mini', '/mini/'].includes(mini.pathname) ||
        mini.search ||
        mini.hash ||
        mini.username ||
        mini.password
      )
        throw new Error();
    } catch {
      errors.push('MINI_APP_URL must be a public HTTPS URL ending in /mini/.');
    }
  }
  if (env.TELEGRAM_BOT_TOKEN && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(env.TELEGRAM_BOT_TOKEN))
    errors.push('TELEGRAM_BOT_TOKEN must be a BotFather token.');
  if (
    env.TELEGRAM_CHAT_ID &&
    (!/^-100\d+$/.test(env.TELEGRAM_CHAT_ID) || !Number.isSafeInteger(Number(env.TELEGRAM_CHAT_ID)))
  )
    errors.push('TELEGRAM_CHAT_ID must be a numeric supergroup ID beginning with -100.');
  if (
    env.DATABASE_ROOT_CHAT_ID &&
    (!/^-100\d+$/.test(env.DATABASE_ROOT_CHAT_ID) ||
      !Number.isSafeInteger(Number(env.DATABASE_ROOT_CHAT_ID)))
  )
    errors.push('DATABASE_ROOT_CHAT_ID must be a numeric supergroup ID beginning with -100.');
  if (
    env.OWNER_TELEGRAM_ID &&
    (!/^[1-9]\d*$/.test(env.OWNER_TELEGRAM_ID) ||
      !Number.isSafeInteger(Number(env.OWNER_TELEGRAM_ID)))
  )
    errors.push('OWNER_TELEGRAM_ID must be a positive numeric Telegram user ID.');
  if (env.TELEGRAM_BOT_USERNAME && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(env.TELEGRAM_BOT_USERNAME))
    errors.push('TELEGRAM_BOT_USERNAME must omit @ and contain a valid Telegram username.');
  if (env.TELEGRAM_WEBHOOK_SECRET && !/^[A-Za-z0-9_-]{16,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET))
    errors.push('TELEGRAM_WEBHOOK_SECRET must contain 16–256 URL-safe characters.');
  if (env.BROWSER_AUTH_TOKEN && !/^[A-Za-z0-9_-]{43,256}$/.test(env.BROWSER_AUTH_TOKEN))
    errors.push('BROWSER_AUTH_TOKEN must contain 43–256 URL-safe characters.');
  if (env.CRON_SECRET && !/^[A-Za-z0-9_-]{32,256}$/.test(env.CRON_SECRET))
    errors.push('CRON_SECRET must contain 32–256 URL-safe characters.');
  if (provider === 'vercel' && requireGeneratedSecrets && !env.CRON_SECRET)
    errors.push('Set CRON_SECRET.');
  if (!['verify-full', 'disable'].includes(env.DATABASE_SSL_MODE))
    errors.push(
      'DATABASE_SSL_MODE must be verify-full or disable (explicit private-network connections only).',
    );
  if (env.DATABASE_URL) {
    try {
      const db = new URL(env.DATABASE_URL);
      if (
        !['postgres:', 'postgresql:'].includes(db.protocol) ||
        !db.hostname ||
        !db.username ||
        !db.pathname.replace(/\//g, '') ||
        db.hash
      )
        throw new Error();
      if (
        ['127.0.0.1', 'localhost', '[::1]'].includes(db.hostname) &&
        env.DATABASE_SSL_MODE !== 'disable'
      )
        errors.push(
          'Loopback PostgreSQL requires explicit DATABASE_SSL_MODE=disable for a private/test connection.',
        );
    } catch {
      errors.push(
        'DATABASE_URL must be a PostgreSQL connection URL including a user and database.',
      );
    }
  }
  if (env.DATABASE_SSL_CA && (env.DATABASE_SSL_MODE === 'disable' || env.HYPERDRIVE_ID))
    errors.push('Configure DATABASE_SSL_CA only for a direct, verified TLS connection.');
  const adminKeys = ['TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'TELEGRAM_SESSION_KEY'];
  if (adminKeys.some((key) => env[key])) {
    if (
      !/^[1-9]\d*$/.test(env.TELEGRAM_API_ID || '') ||
      !Number.isSafeInteger(Number(env.TELEGRAM_API_ID)) ||
      !/^[a-f0-9]{32}$/i.test(env.TELEGRAM_API_HASH || '') ||
      !/^[a-f0-9]{64}$/i.test(env.TELEGRAM_SESSION_KEY || '')
    )
      errors.push(
        'Optional Telegram admin support requires TELEGRAM_API_ID, TELEGRAM_API_HASH, and the existing 64-hex-character TELEGRAM_SESSION_KEY together.',
      );
  }
  const access = ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ADMIN_EMAIL'];
  if (access.some((key) => env[key]) && access.some((key) => !env[key]))
    errors.push(
      'Cloudflare Access requires ACCESS_TEAM_DOMAIN, ACCESS_AUD, and ADMIN_EMAIL together.',
    );
  if (env.ACCESS_TEAM_DOMAIN)
    try {
      validatePublicOrigin(env.ACCESS_TEAM_DOMAIN, 'ACCESS_TEAM_DOMAIN');
    } catch (error) {
      errors.push(error.message);
    }
  if (provider && !providers.includes(provider))
    errors.push(`Provider must be one of: ${providers.join(', ')}.`);
  if (provider === 'cloudflare') {
    if (!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID || ''))
      errors.push('Set CLOUDFLARE_ACCOUNT_ID to your 32-character Cloudflare account ID.');
    if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(env.WATCHTOWER_NAME || ''))
      errors.push(
        'Set WATCHTOWER_NAME to your own Worker name (2–63 lowercase letters, digits, or hyphens).',
      );
    if (env.HYPERDRIVE_ID && !/^[a-f0-9]{32}$/i.test(env.HYPERDRIVE_ID))
      errors.push('HYPERDRIVE_ID must be your 32-character Hyperdrive ID.');
    if (env.CLOUDFLARE_CUSTOM_DOMAIN) {
      try {
        const domain = env.CLOUDFLARE_CUSTOM_DOMAIN;
        validatePublicOrigin(`https://${domain}`, 'CLOUDFLARE_CUSTOM_DOMAIN');
        if (domain !== new URL(`https://${domain}`).hostname) throw new Error();
      } catch {
        errors.push('CLOUDFLARE_CUSTOM_DOMAIN must be a hostname without a protocol or path.');
      }
    }
  }
  return { env, errors };
}

export function generatedEnvironment(input, provider, browserAuth = false) {
  const env = canonicalEnvironment(input);
  env.WATCHTOWER_PROVIDER = provider;
  env.DEV_MODE = 'false';
  env.DATABASE_BACKEND = 'postgres';
  env.DATABASE_ROOT_CHAT_ID ||= env.TELEGRAM_CHAT_ID;
  env.DATABASE_SSL_MODE ||= 'verify-full';
  env.TELEGRAM_WEBHOOK_SECRET ||= randomBytes(32).toString('base64url');
  env.CRON_SECRET ||= randomBytes(32).toString('base64url');
  if (browserAuth) env.BROWSER_AUTH_TOKEN ||= randomBytes(32).toString('base64url');
  return env;
}

export function dotenvLine(key, value) {
  // Single quotes preserve literal backslashes and JSON. Use double quotes only when needed.
  if (!String(value).includes("'")) return `${key}='${value}'`;
  if (!String(value).includes('"') && !String(value).includes('\\')) return `${key}="${value}"`;
  throw new Error(
    `${key} contains unsupported quote combinations; supply it directly in the process environment.`,
  );
}

// A selected custom input is just as private as generated outputs. Outside a Git
// checkout there is no index to leak into; private permissions still apply.
export function assertPrivatePaths(cwd, paths) {
  const rootResult = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (rootResult.status !== 0) return;
  const root = rootResult.stdout.trim();
  for (const path of paths) {
    const requested = resolve(cwd, path);
    if (existsSync(requested) && lstatSync(requested).isSymbolicLink())
      throw new Error('Refusing to use a symbolic link for private setup output.');
    let ancestor = requested;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    const absolute = resolve(realpathSync(ancestor), relative(ancestor, requested));
    const local = relative(root, absolute);
    if (local === '..' || local.startsWith('../') || isAbsolute(local)) continue;
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', local], {
      cwd: root,
      stdio: 'ignore',
    });
    const ignored = spawnSync('git', ['check-ignore', '--quiet', '--', local], {
      cwd: root,
      stdio: 'ignore',
    });
    if (tracked.status === 0 || ignored.status !== 0)
      throw new Error(
        'A private setup path is tracked or is not ignored by Git. Untrack it if necessary and add its exact path to .gitignore or .git/info/exclude before setup.',
      );
  }
}

export function readCloudflareConfiguration(path) {
  const source = readFileSync(path, 'utf8');
  let json = '';
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      json += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index++;
      json += '\n';
      continue;
    } else if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) throw new Error('Cloudflare config contains an unfinished comment.');
      index = end + 1;
      json += ' ';
      continue;
    } else if (char === ',') {
      let next = index + 1;
      // Leave commas before comments for the second, comment-free pass.
      while (/\s/.test(source[next] || '') && next < source.length) next++;
      if (source[next] === '}' || source[next] === ']') continue;
    }
    json += char;
  }
  // Handle trailing commas separated from a closing bracket by a comment.
  let normalized = '';
  quoted = false;
  escaped = false;
  for (let index = 0; index < json.length; index++) {
    const char = json[index];
    if (!quoted && char === ',') {
      let next = index + 1;
      while (/\s/.test(json[next] || '') && next < json.length) next++;
      if (json[next] === '}' || json[next] === ']') continue;
    }
    normalized += char;
    if (escaped) escaped = false;
    else if (quoted && char === '\\') escaped = true;
    else if (char === '"') quoted = !quoted;
  }
  try {
    return JSON.parse(normalized);
  } catch {
    throw new Error('Cloudflare config must contain valid JSON or JSONC.');
  }
}

export function parseOptions(args, { flags = [], values = [], usage }) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (Object.hasOwn(options, key)) throw new Error(usage);
    if (flags.includes(key)) options[key] = true;
    else if (values.includes(key) && args[index + 1] && !args[index + 1].startsWith('--'))
      options[key] = args[++index];
    else throw new Error(usage);
  }
  return options;
}

export function writePrivate(path, contents, { force = false } = {}) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink())
    throw new Error('Refusing to write private output through a symbolic link.');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    if (readFileSync(path, 'utf8') !== contents && !force)
      throw new Error(`Refusing to replace ${path}; review it and use --force to regenerate.`);
    if (readFileSync(path, 'utf8') === contents) {
      chmodSync(path, 0o600);
      return;
    }
  }
  writeFileSync(path, contents, { mode: 0o600, flag: force ? 'w' : 'wx' });
  chmodSync(path, 0o600);
}

export function saveEnvironmentDefaults(path, env, { replaceKeys = [] } = {}) {
  const previous = existsSync(path)
    ? readFileSync(path, 'utf8')
    : '# Watchtower private environment. Keep this file out of Git.\n';
  const parsed = parseEnv(previous);
  let next = previous;
  for (const key of [...new Set([...environmentKeys, ...modelSecretKeys(env)])]) {
    if (!env[key] || (parsed[key] && !replaceKeys.includes(key))) continue;
    const line = dotenvLine(key, env[key]);
    if (replaceKeys.includes(key) && Object.hasOwn(parsed, key)) {
      // These explicitly selected non-secret settings have single-line values.
      const existing = new RegExp(`^(?:export[ \t]+)?${key}[ \t]*=.*$`, 'gm');
      next = next.replace(existing, () => line);
      continue;
    }
    // Fill empty placeholders, while preserving every existing nonempty credential and comment.
    const empty = new RegExp(`^${key}=(?:[ \\t]*|[ \\t]*(?:''|\"\")[ \\t]*)$`, 'm');
    if (empty.test(next)) next = next.replace(empty, () => line);
    else next = `${next.trimEnd()}\n${line}\n`;
  }
  if (next !== previous || !existsSync(path)) writePrivate(path, next, { force: true });
  else chmodSync(path, 0o600);
}

export function runtimeEnvironment(env) {
  return Object.fromEntries(
    [...publicKeys, ...runtimeSecretKeys(env)]
      .filter((key) => env[key])
      .map((key) => [key, env[key]]),
  );
}

export function cloudflareConfiguration(env) {
  return {
    $schema: 'node_modules/wrangler/config-schema.json',
    name: env.WATCHTOWER_NAME,
    account_id: env.CLOUDFLARE_ACCOUNT_ID,
    main: 'worker/index.ts',
    compatibility_date: '2026-10-10',
    compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
    workers_dev: true,
    preview_urls: false,
    ...(env.CLOUDFLARE_CUSTOM_DOMAIN
      ? { routes: [{ pattern: env.CLOUDFLARE_CUSTOM_DOMAIN, custom_domain: true }] }
      : {}),
    assets: {
      directory: './dist',
      binding: 'ASSETS',
      not_found_handling: 'single-page-application',
      run_worker_first: true,
    },
    migrations: [{ tag: 'v1-admin', new_sqlite_classes: ['TelegramAdmin'] }],
    durable_objects: { bindings: [{ name: 'TELEGRAM_ADMIN', class_name: 'TelegramAdmin' }] },
    triggers: { crons: ['* * * * *', '17 3 * * *'] },
    observability: { enabled: true },
    ...(env.HYPERDRIVE_ID
      ? { hyperdrive: [{ binding: 'HYPERDRIVE', id: env.HYPERDRIVE_ID }] }
      : {}),
    vars: Object.fromEntries(publicKeys.filter((key) => env[key]).map((key) => [key, env[key]])),
  };
}

export function writeSetupOutputs(cwd, env, provider, { force = false } = {}) {
  // Admin database URLs and hosting API tokens are deliberately absent from runtime outputs.
  const runtime = runtimeEnvironment(env);
  const outputs = [
    [
      resolve(cwd, '.watchtower/runtime.env'),
      `${Object.entries(runtime)
        .map(([key, value]) => dotenvLine(key, value))
        .join('\n')}\n`,
    ],
    [
      resolve(cwd, '.watchtower/secrets.json'),
      `${JSON.stringify(
        Object.fromEntries(
          runtimeSecretKeys(env)
            .filter((key) => env[key])
            .map((key) => [key, env[key]]),
        ),
        null,
        2,
      )}\n`,
    ],
    [
      resolve(cwd, '.watchtower/setup.json'),
      `${JSON.stringify({ provider, name: env.WATCHTOWER_NAME || 'watchtower' }, null, 2)}\n`,
    ],
  ];
  if (provider === 'cloudflare')
    outputs.push([
      resolve(cwd, 'wrangler.generated.jsonc'),
      `${JSON.stringify(cloudflareConfiguration(env), null, 2)}\n`,
    ]);
  // Preflight every output before changing any; partial regeneration must not mix environments.
  for (const [path, contents] of outputs)
    if (existsSync(path) && readFileSync(path, 'utf8') !== contents && !force)
      throw new Error(`Refusing to replace ${path}; review it and use --force to regenerate.`);
  for (const [path, contents] of outputs) writePrivate(path, contents, { force });
  return outputs.map(([path]) => path);
}

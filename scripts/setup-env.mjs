import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

// Share one precedence rule across setup, Telegram utilities, and database bootstrap.
// An explicit missing file is an error, so a typo never falls back to other credentials.
export function loadEnvironment({ cwd = process.cwd(), env = process.env } = {}) {
  const selector =
    env.UNSPAMMED_ENV_FILE !== undefined ? 'UNSPAMMED_ENV_FILE' : 'WATCHTOWER_ENV_FILE';
  const explicit = env[selector];
  const path = explicit
    ? resolve(cwd, explicit)
    : ['.env', '.dev.vars'].map((name) => resolve(cwd, name)).find(existsSync);
  if (explicit && !existsSync(path)) throw new Error(`${selector} does not exist.`);
  if (path) {
    const parsed = parseEnv(readFileSync(path, 'utf8'));
    const processKeys = new Set(Object.keys(env).filter((key) => env[key] !== undefined));
    for (const [key, value] of Object.entries(parsed)) {
      const alias = key.startsWith('UNSPAMMED_')
        ? key.replace(/^UNSPAMMED_/, 'WATCHTOWER_')
        : key.startsWith('WATCHTOWER_')
          ? key.replace(/^WATCHTOWER_/, 'UNSPAMMED_')
          : key;
      if (!processKeys.has(key) && !processKeys.has(alias)) env[key] = value;
    }
  }
  return { path, env };
}

export function canonicalEnvironment(env = process.env) {
  // Installed WATCHTOWER_* options remain valid. New setup writes UNSPAMMED_*;
  // a supplied canonical value wins when both spellings are present.
  const branded = { ...env };
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('WATCHTOWER_')) branded[key.replace(/^WATCHTOWER_/, 'UNSPAMMED_')] ??= value;
  }
  return {
    ...branded,
    PUBLIC_URL: env.PUBLIC_URL || env.WORKER_URL || '',
    DATABASE_URL: env.DATABASE_URL || env.PLANETSCALE_DATABASE_URL || '',
    DATABASE_ADMIN_URL: env.DATABASE_ADMIN_URL || env.PLANETSCALE_ADMIN_DATABASE_URL || '',
    DATABASE_SSL_MODE: env.DATABASE_SSL_MODE || 'verify-full',
  };
}

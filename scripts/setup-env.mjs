import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

// Share one precedence rule across setup, Telegram utilities, and database bootstrap.
// An explicit missing file is an error, so a typo never falls back to other credentials.
export function loadEnvironment({ cwd = process.cwd(), env = process.env } = {}) {
  const explicit = env.WATCHTOWER_ENV_FILE;
  const path = explicit
    ? resolve(cwd, explicit)
    : ['.env', '.dev.vars'].map((name) => resolve(cwd, name)).find(existsSync);
  if (explicit && !existsSync(path)) throw new Error('WATCHTOWER_ENV_FILE does not exist.');
  if (path) {
    const parsed = parseEnv(readFileSync(path, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] === undefined) env[key] = value;
    }
  }
  return { path, env };
}

export function canonicalEnvironment(env = process.env) {
  return {
    ...env,
    PUBLIC_URL: env.PUBLIC_URL || env.WORKER_URL || '',
    DATABASE_URL: env.DATABASE_URL || env.PLANETSCALE_DATABASE_URL || '',
    DATABASE_ADMIN_URL: env.DATABASE_ADMIN_URL || env.PLANETSCALE_ADMIN_DATABASE_URL || '',
    DATABASE_SSL_MODE: env.DATABASE_SSL_MODE || 'verify-full',
  };
}

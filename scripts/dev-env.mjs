import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import {
  environmentKeys,
  dotenvLine,
  writePrivate,
  assertPrivatePaths,
  modelSecretKeys,
} from './setup-lib.mjs';

export function prepareDevEnvironment({ cwd = process.cwd(), env = process.env } = {}) {
  const selector =
    env.UNSPAMMED_ENV_FILE !== undefined ? 'UNSPAMMED_ENV_FILE' : 'WATCHTOWER_ENV_FILE';
  const explicit = env[selector];
  const source = explicit ? resolve(cwd, explicit) : resolve(cwd, '.dev.vars.example');
  if (!existsSync(source))
    throw new Error(explicit ? `${selector} does not exist.` : 'Missing .dev.vars.example.');
  assertPrivatePaths(cwd, ['.tmp/dev/local.vars']);
  const vars = parseEnv(readFileSync(source, 'utf8'));
  vars.DEV_MODE = 'true';
  vars.DATABASE_BACKEND = 'sqlite';
  vars.TELEGRAM_CHAT_ID ||= '-1001234567890';
  vars.OWNER_TELEGRAM_ID ||= '123456789';
  vars.ADMIN_EMAIL ||= 'owner@example.com';
  // SQLite demo mode never needs a remote database or production browser credentials.
  for (const key of [
    'DATABASE_URL',
    'DATABASE_ADMIN_URL',
    'PLANETSCALE_DATABASE_URL',
    'PLANETSCALE_ADMIN_DATABASE_URL',
    'BROWSER_AUTH_TOKEN',
    'CRON_SECRET',
    'ACCESS_AUD',
    'ACCESS_TEAM_DOMAIN',
  ])
    delete vars[key];
  const path = resolve(cwd, '.tmp/dev/local.vars');
  writePrivate(
    path,
    `${Object.entries(vars)
      .map(([key, value]) => dotenvLine(key, value))
      .join('\n')}\n`,
    { force: true },
  );
  const childEnv = { ...env };
  for (const key of [
    ...environmentKeys,
    ...modelSecretKeys(env),
    'WORKER_URL',
    'PLANETSCALE_DATABASE_URL',
    'PLANETSCALE_ADMIN_DATABASE_URL',
    'UNSPAMMED_ENV_FILE',
    'WATCHTOWER_ENV_FILE',
  ])
    delete childEnv[key];
  childEnv.DEV_MODE = 'true';
  childEnv.DATABASE_BACKEND = 'sqlite';
  return { path, childEnv, explicit: Boolean(explicit) };
}

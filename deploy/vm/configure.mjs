import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { loadEnvironment } from '../../scripts/setup-env.mjs';
import {
  assertPrivatePaths,
  dotenvLine,
  safeErrorMessage,
  writePrivate,
} from '../../scripts/setup-lib.mjs';
import { main as setup } from '../../scripts/setup.mjs';

export async function configure() {
  const { path: inputPath } = loadEnvironment();
  if (!inputPath) throw new Error('Select your private VM input with WATCHTOWER_ENV_FILE.');
  assertPrivatePaths(process.cwd(), [inputPath, '.watchtower/compose.env']);
  const env = process.env;
  const profiles = [...new Set((env.COMPOSE_PROFILES || '').split(',').filter(Boolean))];
  if (profiles.some((profile) => !['bundled-db', 'https'].includes(profile)))
    throw new Error('COMPOSE_PROFILES supports bundled-db and https only.');
  const vmDefaults = {};
  if (profiles.includes('bundled-db')) {
    if (env.DATABASE_ADMIN_URL || env.PLANETSCALE_ADMIN_DATABASE_URL)
      throw new Error('Remove DATABASE_ADMIN_URL when using the bundled database.');
    let connection;
    try {
      connection = env.DATABASE_URL ? new URL(env.DATABASE_URL) : undefined;
    } catch {
      throw new Error('The bundled database requires its private db connection URL.');
    }
    if (
      connection &&
      (!['postgres:', 'postgresql:'].includes(connection.protocol) ||
        connection.hostname !== 'db' ||
        (connection.port && connection.port !== '5432') ||
        connection.username !== 'watchtower' ||
        connection.pathname !== '/watchtower' ||
        connection.search ||
        connection.hash)
    )
      throw new Error('The bundled database URL must use watchtower@db:5432/watchtower.');
    if (env.DATABASE_SSL_MODE && env.DATABASE_SSL_MODE !== 'disable')
      throw new Error('Set DATABASE_SSL_MODE=disable for the private bundled database.');
    vmDefaults.POSTGRES_PASSWORD = env.POSTGRES_PASSWORD || randomBytes(32).toString('hex');
    vmDefaults.WATCHTOWER_DATABASE_PASSWORD =
      env.WATCHTOWER_DATABASE_PASSWORD ||
      (connection?.password && decodeURIComponent(connection.password)) ||
      randomBytes(32).toString('hex');
    if (
      connection &&
      decodeURIComponent(connection.password) !== vmDefaults.WATCHTOWER_DATABASE_PASSWORD
    )
      throw new Error('DATABASE_URL and WATCHTOWER_DATABASE_PASSWORD must match.');
    env.DATABASE_URL ||= `postgresql://watchtower:${encodeURIComponent(vmDefaults.WATCHTOWER_DATABASE_PASSWORD)}@db:5432/watchtower`;
    env.DATABASE_SSL_MODE = 'disable';
    Object.assign(env, vmDefaults);
  }
  const domain = env.WATCHTOWER_DOMAIN || '';
  if (profiles.includes('https')) {
    if (!domain || env.PUBLIC_URL !== `https://${domain}`)
      throw new Error('For the https profile, set PUBLIC_URL=https://WATCHTOWER_DOMAIN.');
  }
  const address = (env.WATCHTOWER_BIND || '127.0.0.1').replace(/^\[|\]$/g, '');
  if (!isIP(address)) throw new Error('WATCHTOWER_BIND must be an IP address (default 127.0.0.1).');
  const bind = isIP(address) === 6 ? `[${address}]` : address;
  const port = env.WATCHTOWER_PORT || '3000';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error('WATCHTOWER_PORT must be an integer from 1 to 65535.');
  await setup(['--provider', 'railway', '--browser-auth', '--force']);
  if (process.exitCode) return;
  // Persist only missing VM credentials. Shared setup preserves the application
  // credentials, namespace and session keys in the same selected input file.
  let contents = readFileSync(inputPath, 'utf8');
  const previous = parseEnv(contents);
  for (const [key, value] of Object.entries(vmDefaults)) {
    if (previous[key]) continue;
    const line = dotenvLine(key, value);
    const placeholder = new RegExp(`^${key}=[ \\t]*(?:''|\"\")?[ \\t]*$`, 'm');
    contents = placeholder.test(contents)
      ? contents.replace(placeholder, () => line)
      : `${contents.trimEnd()}\n${line}\n`;
  }
  writePrivate(inputPath, contents, { force: true });
  const compose = {
    COMPOSE_PROFILES: profiles.join(','),
    WATCHTOWER_DOMAIN: domain,
    WATCHTOWER_BIND: bind,
    WATCHTOWER_PORT: port,
    ...(profiles.includes('bundled-db') ? vmDefaults : {}),
  };
  writePrivate(
    resolve('.watchtower/compose.env'),
    `${Object.entries(compose)
      .map(([key, value]) => dotenvLine(key, value))
      .join('\n')}\n`,
    { force: true },
  );
  console.log('Private VM configuration is ready. Existing credentials were preserved.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  configure().catch((error) => {
    console.error(safeErrorMessage(error));
    process.exitCode = 1;
  });

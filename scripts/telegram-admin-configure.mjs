import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { loadEnvironment, canonicalEnvironment } from './setup-env.mjs';
import {
  saveEnvironmentDefaults,
  writePrivate,
  providers,
  assertPrivatePaths,
  safeErrorMessage,
  parseOptions,
  readCloudflareConfiguration,
} from './setup-lib.mjs';

function wrangler(args, input = '') {
  return new Promise((resolveCall, reject) => {
    const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data) => {
      output += data;
    });
    child.stderr.resume();
    child.on('error', () => reject(new Error('Could not start Wrangler.')));
    child.on('close', (code) =>
      code === 0
        ? resolveCall(output)
        : reject(
            new Error(
              'Wrangler secret operation failed. Check your Cloudflare login and explicit config.',
            ),
          ),
    );
    child.stdin.on('error', () =>
      reject(new Error('Wrangler secret operation could not receive input.')),
    );
    child.stdin.end(input);
  });
}

try {
  const args = process.argv.slice(2);
  const options = parseOptions(args, {
    values: ['--provider', '--config'],
    flags: ['--upload', '--new-session-key'],
    usage:
      'Usage: npm run telegram:admin:configure -- [--provider NAME] [--new-session-key] [--upload --config YOUR_CONFIG]',
  });
  const loaded = loadEnvironment();
  const provider = options['--provider']
    ? options['--provider']
    : canonicalEnvironment(process.env).UNSPAMMED_PROVIDER;
  if (provider && !providers.includes(provider)) throw new Error(`Choose ${providers.join(', ')}.`);
  const upload = args.includes('--upload');
  const config = options['--config'];
  if (upload && (provider !== 'cloudflare' || !config || !existsSync(config)))
    throw new Error(
      'Automatic upload requires --provider cloudflare --upload --config YOUR_CONFIG. Other hosts import the private generated file.',
    );
  if (
    upload &&
    (!readCloudflareConfiguration(config).name ||
      ['unspammed-unconfigured', 'watchtower-unconfigured'].includes(
        readCloudflareConfiguration(config).name,
      ))
  )
    throw new Error(
      'Run setup and select your generated config, or explicitly select your preserved production config.',
    );
  const envPath = loaded.path || resolve('.env');
  assertPrivatePaths(process.cwd(), [
    envPath,
    '.watchtower/admin-secrets.json',
    ...(existsSync('.watchtower/runtime.env') ? ['.watchtower/runtime.env'] : []),
  ]);
  const apiId = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (
    !/^[1-9]\d*$/.test(apiId || '') ||
    !Number.isSafeInteger(Number(apiId)) ||
    !/^[a-f0-9]{32}$/i.test(apiHash || '')
  )
    throw new Error(
      'Set TELEGRAM_API_ID and TELEGRAM_API_HASH from my.telegram.org/apps in your private environment file.',
    );
  let sessionKey = process.env.TELEGRAM_SESSION_KEY;
  if (!sessionKey) {
    if (!args.includes('--new-session-key'))
      throw new Error(
        'Restore TELEGRAM_SESSION_KEY from your backup. Only a fresh installation without saved sessions should use --new-session-key.',
      );
    if (upload) {
      const deployed = await wrangler(['secret', 'list', '--config', config]);
      if (/"name"\s*:\s*"TELEGRAM_SESSION_KEY"/.test(deployed))
        throw new Error(
          'A session encryption key already exists in Cloudflare. Restore its local backup; do not replace it.',
        );
    }
    sessionKey = randomBytes(32).toString('hex');
  }
  if (!/^[a-f0-9]{64}$/i.test(sessionKey))
    throw new Error(
      'TELEGRAM_SESSION_KEY must contain 64 hex characters. Restore the existing key to retain saved sessions.',
    );
  const secrets = {
    TELEGRAM_API_ID: apiId,
    TELEGRAM_API_HASH: apiHash,
    TELEGRAM_SESSION_KEY: sessionKey,
  };
  saveEnvironmentDefaults(envPath, secrets);
  writePrivate(resolve('.watchtower/admin-secrets.json'), `${JSON.stringify(secrets, null, 2)}\n`, {
    force: true,
  });
  // Include new optional values in an already-prepared runtime env without replacing other values.
  if (existsSync('.watchtower/runtime.env'))
    saveEnvironmentDefaults(resolve('.watchtower/runtime.env'), secrets);
  if (upload) await wrangler(['secret', 'bulk', '--config', config], JSON.stringify(secrets));
  console.log(
    upload
      ? 'Telegram admin secrets uploaded to the explicitly selected Cloudflare config.'
      : 'Telegram admin secrets prepared in private .watchtower/admin-secrets.json (0600). Import these three values into your host runtime variables.',
  );
  console.log(
    'The existing session encryption key was preserved and backed up in your private environment file.',
  );
} catch (error) {
  console.error(safeErrorMessage(error));
  process.exitCode = 1;
}

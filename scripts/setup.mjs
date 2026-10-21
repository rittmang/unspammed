import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvironment, canonicalEnvironment } from './setup-env.mjs';
import {
  providers,
  generatedEnvironment,
  saveEnvironmentDefaults,
  validateConfiguration,
  writeSetupOutputs,
  safeErrorMessage,
  assertPrivatePaths,
  parseOptions,
} from './setup-lib.mjs';
import { telegram, checkTelegramConfiguration } from './telegram-client.mjs';

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args, {
    flags: ['--browser-auth', '--doctor', '--check', '--force', '--help'],
    values: ['--provider'],
    usage:
      'Usage: npm run setup -- --provider cloudflare|railway|digitalocean|vercel [--browser-auth] [--force]. Keep credentials in a private env file.',
  });
  if (args.includes('--help')) {
    console.log(
      'Usage: npm run setup -- --provider cloudflare|railway|digitalocean|vercel [--browser-auth] [--force]',
    );
    console.log('Set inputs in .env or WATCHTOWER_ENV_FILE. Legacy .dev.vars is a fallback.');
    console.log(
      '--doctor validates locally; --check also checks Telegram permissions and the public /health endpoint. Both are read-only.',
    );
    console.log(
      '--browser-auth generates a private browser sign-in token. --force regenerates derived files while preserving existing credentials.',
    );
    return;
  }
  const loaded = loadEnvironment();
  const cwd = process.cwd();
  let savedProvider;
  try {
    savedProvider = JSON.parse(
      readFileSync(resolve(cwd, '.watchtower/setup.json'), 'utf8'),
    ).provider;
  } catch {
    /* Fresh checkout. */
  }
  const provider = options['--provider'] || process.env.WATCHTOWER_PROVIDER || savedProvider;
  if (!providers.includes(provider)) throw new Error(`Choose --provider ${providers.join('|')}.`);
  const check = args.includes('--check');
  const doctor = args.includes('--doctor') || check;
  const envPath = process.env.WATCHTOWER_ENV_FILE ? loaded.path : resolve(cwd, '.env');
  if (!doctor)
    assertPrivatePaths(cwd, [
      envPath,
      '.watchtower/runtime.env',
      '.watchtower/secrets.json',
      '.watchtower/setup.json',
      ...(provider === 'cloudflare' ? ['wrangler.generated.jsonc'] : []),
    ]);
  const env = doctor
    ? canonicalEnvironment(process.env)
    : generatedEnvironment(process.env, provider, args.includes('--browser-auth'));
  if (!doctor)
    saveEnvironmentDefaults(envPath, env, {
      replaceKeys: ['DEV_MODE', 'DATABASE_BACKEND', 'WATCHTOWER_PROVIDER'],
    });
  const { errors } = validateConfiguration(env, provider);
  if (env.DEV_MODE !== 'false') errors.push('Set DEV_MODE=false before a production deployment.');
  if (env.DATABASE_BACKEND !== 'postgres')
    errors.push('Set DATABASE_BACKEND=postgres for a hosted deployment.');
  if (errors.length) {
    for (const error of errors) console.error(`- ${error}`);
    if (!doctor)
      console.error(
        'Private setup inputs were saved without replacing existing credentials. Fill the missing values in .env (or WATCHTOWER_ENV_FILE), then rerun setup.',
      );
    process.exitCode = 1;
    return;
  }
  if (check) {
    const result = await checkTelegramConfiguration(env, (method, body) =>
      telegram(method, body, env),
    );
    console.log(`Telegram: @${result.me.username}; bot and owner permissions verified.`);
    const response = await fetch(new URL('/health', env.PUBLIC_URL), {
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    await response.body?.cancel();
    if (response.status !== 200)
      throw new Error(
        `Public /health returned HTTP ${response.status}. Finish deployment and DNS/TLS configuration before Telegram setup.`,
      );
    console.log('Public HTTPS /health is reachable. No webhook or menu settings changed.');
  }
  if (doctor) {
    console.log(`Local ${provider} configuration is valid. Secrets were not printed.`);
    if (!env.BROWSER_AUTH_TOKEN && !env.ACCESS_AUD)
      console.log('Browser sign-in is not configured; the owner can use the Telegram Mini App.');
    return;
  }
  writeSetupOutputs(cwd, env, provider, { force: args.includes('--force') });
  console.log(
    `Prepared ${provider} configuration and private .watchtower/runtime.env (0600). Existing credentials were preserved.`,
  );
  if (provider === 'cloudflare')
    console.log(
      'Review wrangler.generated.jsonc; upload .watchtower/secrets.json using Wrangler secret bulk --config wrangler.generated.jsonc, then npm run deploy.',
    );
  if (provider === 'railway')
    console.log(
      'Connect your repository to Railway; use railway.json and import .watchtower/runtime.env as service variables.',
    );
  if (provider === 'digitalocean')
    console.log(
      'Set your repository in .do/app.yaml; import .watchtower/runtime.env as runtime variables in App Platform before creating the app.',
    );
  if (provider === 'vercel')
    console.log(
      'Import .watchtower/runtime.env into Vercel Production variables; use vercel.json and a plan supporting minute cron jobs and 300-second functions.',
    );
  console.log(
    'Next: npm run database:setup, deploy to your own account, npm run setup:check, then npm run telegram:setup. No resources were created.',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(safeErrorMessage(error));
    process.exitCode = 1;
  });
}

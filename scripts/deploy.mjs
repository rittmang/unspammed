import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadEnvironment } from './setup-env.mjs';
import {
  validateConfiguration,
  cloudflareConfiguration,
  safeErrorMessage,
  parseOptions,
  readCloudflareConfiguration,
} from './setup-lib.mjs';
import { isDeepStrictEqual } from 'node:util';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', () => reject(new Error(`Could not start ${command}.`)));
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Deployment command failed (exit ${code}).`)),
    );
  });
}

try {
  const args = process.argv.slice(2);
  const options = parseOptions(args, {
    values: ['--config'],
    flags: ['--dry-run', '--check'],
    usage: 'Usage: npm run deploy -- [--config YOUR_CONFIG] [--dry-run|--check]',
  });
  const explicit = Boolean(options['--config']);
  const configPath = options['--config'] || 'wrangler.generated.jsonc';
  if (!configPath || !existsSync(configPath))
    throw new Error(
      'No deployment config. Run npm run setup -- --provider cloudflare, or explicitly select your preserved production config with --config wrangler.production.jsonc.',
    );
  const config = readCloudflareConfiguration(configPath);
  if (!config.name || config.name === 'watchtower-unconfigured')
    throw new Error(
      'Refusing to deploy the unconfigured starter. Run setup for your own Cloudflare account.',
    );
  if (!explicit) {
    loadEnvironment();
    const { env, errors } = validateConfiguration(process.env, 'cloudflare');
    if (errors.length)
      throw new Error(`Deployment configuration is incomplete. ${errors.join(' ')}`);
    if (!isDeepStrictEqual(config, cloudflareConfiguration(env)))
      throw new Error(
        'Generated config does not match your current runtime inputs. Review inputs and rerun setup --force.',
      );
  }
  console.log(`Cloudflare config verified for Worker ${config.name}.`);
  if (!args.includes('--check')) {
    await run('npm', ['run', 'build']);
    await run(process.execPath, [
      'node_modules/wrangler/bin/wrangler.js',
      'deploy',
      '--config',
      configPath,
      ...(args.includes('--dry-run') ? ['--dry-run'] : []),
    ]);
  }
} catch (error) {
  console.error(safeErrorMessage(error));
  process.exitCode = 1;
}

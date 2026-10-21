import { isIPv4 } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { telegram, checkTelegramConfiguration } from './telegram-client.mjs';
import { canonicalEnvironment, loadEnvironment } from './setup-env.mjs';
import {
  saveEnvironmentDefaults,
  validatePublicOrigin,
  safeErrorMessage,
  assertPrivatePaths,
} from './setup-lib.mjs';

export async function configureWebhook(input = process.env, call, { check = false } = {}) {
  const env = canonicalEnvironment(input);
  call ||= (method, body) => telegram(method, body, env);
  if (!/^[A-Za-z0-9_-]{16,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET || ''))
    throw new Error('Set TELEGRAM_WEBHOOK_SECRET; npm run setup generates a secure value.');
  const origin = validatePublicOrigin(env.PUBLIC_URL);
  if (env.TELEGRAM_WEBHOOK_IP && !isIPv4(env.TELEGRAM_WEBHOOK_IP))
    throw new Error('TELEGRAM_WEBHOOK_IP must be an IPv4 address for your webhook host.');
  const { me } = await checkTelegramConfiguration(env, call);
  const url = new URL('/telegram/webhook', origin).href;
  if (!check)
    await call('setWebhook', {
      url,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message', 'edited_message', 'my_chat_member'],
      max_connections: 10,
      drop_pending_updates: false,
      ...(env.TELEGRAM_WEBHOOK_IP ? { ip_address: env.TELEGRAM_WEBHOOK_IP } : {}),
    });
  const info = await call('getWebhookInfo');
  if (info.url !== url)
    throw new Error(
      'Webhook URL does not match PUBLIC_URL. Run npm run telegram:setup after deployment.',
    );
  return { me, url, pending: info.pending_update_count };
}

async function main() {
  if (process.argv.slice(2).some((arg) => arg !== '--check'))
    throw new Error('Usage: npm run telegram:setup -- [--check]');
  const loaded = loadEnvironment();
  const check = process.argv.includes('--check');
  if (!check && loaded.path) assertPrivatePaths(process.cwd(), [loaded.path]);
  const result = await configureWebhook(process.env, telegram, { check });
  if (!check && loaded.path)
    saveEnvironmentDefaults(loaded.path, { TELEGRAM_BOT_USERNAME: result.me.username });
  console.log(
    `@${result.me.username} webhook ${check ? 'verified' : 'registered'} at ${result.url}`,
  );
  console.log(
    `Pending updates: ${Number(result.pending) || 0}. Pending updates were preserved. Start in observation mode.`,
  );
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(safeErrorMessage(error));
    process.exitCode = 1;
  });
}

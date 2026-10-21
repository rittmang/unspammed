import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { telegram } from './telegram-client.mjs';
import { canonicalEnvironment, loadEnvironment } from './setup-env.mjs';
import {
  saveEnvironmentDefaults,
  validatePublicOrigin,
  safeErrorMessage,
  assertPrivatePaths,
  parseOptions,
} from './setup-lib.mjs';

export async function configureMiniApp(
  input = process.env,
  call,
  { reset = false, check = false, request = fetch } = {},
) {
  const env = canonicalEnvironment(input);
  call ||= (method, body) => telegram(method, body, env);
  const owner = env.OWNER_TELEGRAM_ID;
  if (!/^[1-9]\d*$/.test(owner || '') || !Number.isSafeInteger(Number(owner)))
    throw new Error('Set a numeric OWNER_TELEGRAM_ID.');
  if (reset && check) throw new Error('Choose either --check or --reset.');
  let url;
  if (!reset) {
    const origin = validatePublicOrigin(env.PUBLIC_URL);
    const entry = new URL(env.MINI_APP_URL || new URL('/mini/', origin));
    validatePublicOrigin(entry.origin, 'MINI_APP_URL');
    if (
      entry.username ||
      entry.password ||
      !['/mini', '/mini/'].includes(entry.pathname) ||
      entry.search ||
      entry.hash
    )
      throw new Error('MINI_APP_URL must be a public HTTPS URL ending in /mini/.');
    entry.pathname = '/mini/';
    url = entry.href;
    const response = await request(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    await response.body?.cancel();
    if (response.status !== 200)
      throw new Error(
        `Mini App returned HTTP ${response.status}. Make /mini and /mini/* publicly reachable; use an Access bypass if needed.`,
      );
  }
  const me = await call('getMe');
  if (!me.is_bot || !me.username)
    throw new Error('The configured token did not identify a Telegram bot.');
  if (
    env.TELEGRAM_BOT_USERNAME &&
    me.username.toLowerCase() !== env.TELEGRAM_BOT_USERNAME.toLowerCase()
  )
    throw new Error('TELEGRAM_BOT_USERNAME does not match the token.');
  const chat = await call('getChat', { chat_id: Number(owner) });
  if (chat.type !== 'private' || String(chat.id) !== owner)
    throw new Error('Open the bot in your own private chat and send /start first.');
  const before = await call('getChatMenuButton', { chat_id: Number(owner) });
  const desired = reset
    ? { type: 'default' }
    : { type: 'web_app', text: 'Open dashboard', web_app: { url } };
  const matches = (menu) =>
    reset ? menu.type === 'default' : menu.type === 'web_app' && menu.web_app?.url === url;
  if (!check && !matches(before))
    await call('setChatMenuButton', { chat_id: Number(owner), menu_button: desired });
  const menu = await call('getChatMenuButton', { chat_id: Number(owner) });
  if (!matches(menu))
    throw new Error(
      'The owner menu does not match. Run npm run telegram:mini-app to configure it.',
    );
  return { me, url, menu };
}

async function main() {
  const options = parseOptions(process.argv.slice(2), {
    flags: ['--reset', '--check'],
    usage: 'Usage: npm run telegram:mini-app -- [--check|--reset]',
  });
  const loaded = loadEnvironment();
  const check = Boolean(options['--check']);
  const reset = Boolean(options['--reset']);
  if (!check && loaded.path) assertPrivatePaths(process.cwd(), [loaded.path]);
  const { me } = await configureMiniApp(process.env, undefined, { check, reset });
  if (!check && loaded.path)
    saveEnvironmentDefaults(loaded.path, { TELEGRAM_BOT_USERNAME: me.username });
  console.log(
    `@${me.username}: owner-only menu ${reset ? 'reset' : check ? 'verified' : 'configured'}. The global bot menu was unchanged.`,
  );
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(safeErrorMessage(error));
    process.exitCode = 1;
  });
}

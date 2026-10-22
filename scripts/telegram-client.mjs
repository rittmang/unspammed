import { safeErrorMessage } from './setup-lib.mjs';
import { canonicalEnvironment } from './setup-env.mjs';

export async function telegram(method, body = {}, env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token)
    throw new Error(
      'Set TELEGRAM_BOT_TOKEN in .env, UNSPAMMED_ENV_FILE (legacy WATCHTOWER_ENV_FILE), or your environment.',
    );
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error(`${method}: Telegram request failed or timed out.`);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`${method}: Telegram returned an invalid response (HTTP ${response.status}).`);
  }
  if (!data.ok) {
    const description = safeErrorMessage(
      new Error(String(data.description || response.status)),
      env,
    );
    throw new Error(`${method} failed: ${description}`);
  }
  return data.result;
}

export async function checkTelegramConfiguration(input = process.env, call) {
  const env = canonicalEnvironment(input);
  call ||= (method, body) => telegram(method, body, env);
  const chatId = env.TELEGRAM_CHAT_ID;
  const ownerId = env.OWNER_TELEGRAM_ID;
  if (
    !/^-100\d+$/.test(chatId || '') ||
    !/^[1-9]\d*$/.test(ownerId || '') ||
    !Number.isSafeInteger(Number(chatId)) ||
    !Number.isSafeInteger(Number(ownerId))
  )
    throw new Error(
      'Set numeric TELEGRAM_CHAT_ID (supergroup) and OWNER_TELEGRAM_ID. Run npm run telegram:discover for guidance.',
    );
  const me = await call('getMe');
  if (!me.is_bot || !me.username)
    throw new Error('The configured token did not identify a Telegram bot.');
  if (
    env.TELEGRAM_BOT_USERNAME &&
    env.TELEGRAM_BOT_USERNAME.toLowerCase() !== me.username.toLowerCase()
  )
    throw new Error('TELEGRAM_BOT_USERNAME does not match the configured bot token.');
  const chat = await call('getChat', { chat_id: chatId });
  if (chat.type !== 'supergroup' || String(chat.id) !== chatId)
    throw new Error('TELEGRAM_CHAT_ID must identify your Telegram supergroup.');
  const membership = await call('getChatMember', { chat_id: chatId, user_id: me.id });
  const owner = await call('getChatMember', { chat_id: chatId, user_id: Number(ownerId) });
  if (
    membership.status !== 'administrator' ||
    !membership.can_delete_messages ||
    !membership.can_restrict_members
  )
    throw new Error(
      'Make the bot a supergroup administrator with Delete messages and Ban users permissions.',
    );
  if (!['creator', 'administrator'].includes(owner.status))
    throw new Error('OWNER_TELEGRAM_ID must be an administrator of the supergroup.');
  return { me, chat, membership, owner };
}

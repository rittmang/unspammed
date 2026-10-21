import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeErrorMessage } from './setup-lib.mjs';
import { telegram } from './telegram-client.mjs';
import { loadEnvironment } from './setup-env.mjs';

export async function discoverTelegram(call = telegram) {
  const me = await call('getMe');
  const webhook = await call('getWebhookInfo');
  console.log(`Bot: @${me.username} (${me.id})`);
  if (webhook.url) {
    console.log('A webhook is already configured. Discovery polling cannot run alongside it.');
    console.log(
      'The webhook and pending updates were preserved. Use known IDs from your own private configuration.',
    );
    console.log(
      'For a fresh bot: create a supergroup, add the bot as admin, send a group message and /start privately, then rerun discovery before registering its webhook.',
    );
    return;
  }

  // No offset: reading these updates does not acknowledge or discard them.
  const updates = await call('getUpdates', { timeout: 0, limit: 100 });
  const groups = new Map();
  const people = new Map();
  for (const update of updates) {
    const event = update.message || update.edited_message || update.my_chat_member;
    if (!event) continue;
    if (['group', 'supergroup'].includes(event.chat?.type)) {
      groups.set(event.chat.id, {
        id: event.chat.id,
        title: event.chat.title,
        type: event.chat.type,
      });
    }
    if (event.from && !event.from.is_bot) {
      people.set(event.from.id, {
        id: event.from.id,
        name: event.from.first_name,
        username: event.from.username,
        seenIn: event.chat?.type,
      });
    }
  }
  console.log(
    JSON.stringify({ groups: [...groups.values()], people: [...people.values()] }, null, 2),
  );
  if (!groups.size || !people.size) {
    console.log(
      'Create or upgrade to a supergroup, add the bot as admin with Delete messages and Ban users, send a group message and /start privately, then rerun discovery. Save the -100… group ID as TELEGRAM_CHAT_ID and your positive user ID as OWNER_TELEGRAM_ID.',
    );
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  Promise.resolve()
    .then(() => {
      loadEnvironment();
      return discoverTelegram();
    })
    .catch((error) => {
      console.error(safeErrorMessage(error));
      process.exitCode = 1;
    });
}

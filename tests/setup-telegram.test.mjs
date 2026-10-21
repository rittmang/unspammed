import assert from 'node:assert/strict';
import { test } from 'node:test';
import { telegram, checkTelegramConfiguration } from '../scripts/telegram-client.mjs';
import { configureWebhook } from '../scripts/telegram-setup.mjs';
import { configureMiniApp } from '../scripts/telegram-mini-app.mjs';
import { discoverTelegram } from '../scripts/telegram-discover.mjs';

const env = {
  PUBLIC_URL: 'https://install.example',
  TELEGRAM_BOT_TOKEN: '987654321:FIXTURE_BOT_TOKEN_NEVER_CONTACT_TELEGRAM',
  TELEGRAM_WEBHOOK_SECRET: 'w'.repeat(43),
  TELEGRAM_CHAT_ID: '-1009876543210',
  OWNER_TELEGRAM_ID: '234567890',
  TELEGRAM_BOT_USERNAME: 'fixture_owner_bot',
};
const me = { id: 987654321, is_bot: true, username: env.TELEGRAM_BOT_USERNAME };
function fixture(overrides = {}) {
  const calls = [];
  let menu = overrides.menu || { type: 'default' };
  const call = async (method, body) => {
    calls.push({ method, body });
    if (Object.hasOwn(overrides, method))
      return typeof overrides[method] === 'function' ? overrides[method](body) : overrides[method];
    if (method === 'getMe') return me;
    if (method === 'getChat')
      return String(body.chat_id) === env.OWNER_TELEGRAM_ID
        ? { id: Number(env.OWNER_TELEGRAM_ID), type: 'private' }
        : { id: Number(env.TELEGRAM_CHAT_ID), type: 'supergroup' };
    if (method === 'getChatMember')
      return body.user_id === me.id
        ? { status: 'administrator', can_delete_messages: true, can_restrict_members: true }
        : { status: 'administrator' };
    if (method === 'setWebhook') return true;
    if (method === 'getWebhookInfo')
      return { url: env.PUBLIC_URL + '/telegram/webhook', pending_update_count: 7 };
    if (method === 'getChatMenuButton') return menu;
    if (method === 'setChatMenuButton') {
      menu = body.menu_button;
      return true;
    }
    throw new Error(`Unexpected external operation: ${method}`);
  };
  return { calls, call };
}
const publicShell = async () => new Response('<!doctype html>', { status: 200 });

test('webhook setup verifies exact bot, group, and owner permissions before registration and preserves pending updates', async () => {
  const mock = fixture();
  const result = await configureWebhook(env, mock.call);
  const registration = mock.calls.find((call) => call.method === 'setWebhook');
  assert.equal(registration.body.url, env.PUBLIC_URL + '/telegram/webhook');
  assert.equal(registration.body.secret_token, env.TELEGRAM_WEBHOOK_SECRET);
  assert.equal(registration.body.drop_pending_updates, false);
  assert.deepEqual(registration.body.allowed_updates, [
    'message',
    'edited_message',
    'my_chat_member',
  ]);
  assert.equal(result.pending, 7);
  assert.deepEqual(
    mock.calls.filter((call) => call.method === 'getChatMember').map((call) => call.body.user_id),
    [me.id, Number(env.OWNER_TELEGRAM_ID)],
  );
  assert(
    mock.calls.findIndex((call) => call.method === 'setWebhook') >
      mock.calls.findIndex((call) => call.method === 'getChatMember'),
  );
  assert(
    !mock.calls.some((call) =>
      ['deleteMessage', 'banChatMember', 'deleteWebhook'].includes(call.method),
    ),
  );
});

test('read-only webhook check never changes Telegram configuration', async () => {
  const mock = fixture();
  await configureWebhook(env, mock.call, { check: true });
  assert(!mock.calls.some((call) => call.method.startsWith('set')));
  await assert.rejects(
    configureWebhook(
      env,
      fixture({ getWebhookInfo: { url: 'https://other.example/telegram/webhook' } }).call,
      { check: true },
    ),
    /does not match/,
  );
});

test('incorrect bot identity, non-supergroup, missing bot permissions, and non-owner membership prevent registration', async () => {
  for (const overrides of [
    { getMe: { ...me, username: 'another_owner_bot' } },
    { getMe: { ...me, is_bot: false } },
    { getChat: { id: Number(env.TELEGRAM_CHAT_ID), type: 'group' } },
    { getChatMember: { status: 'member' } },
    {
      getChatMember: (body) =>
        body.user_id === me.id
          ? { status: 'administrator', can_delete_messages: true, can_restrict_members: true }
          : { status: 'member' },
    },
  ]) {
    const mock = fixture(overrides);
    await assert.rejects(configureWebhook(env, mock.call));
    assert(!mock.calls.some((call) => call.method === 'setWebhook'));
  }
  await assert.rejects(
    checkTelegramConfiguration({ ...env, OWNER_TELEGRAM_ID: '9007199254740993' }, fixture().call),
    /numeric/,
  );
});

test('Telegram calls use the provided environment and redact request failures and API descriptions', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    seen.push(String(url));
    const method = String(url).split('/').at(-1);
    const body = JSON.parse(options.body);
    const mock = fixture();
    return Response.json({ ok: true, result: await mock.call(method, body) });
  });
  await checkTelegramConfiguration(env);
  assert(
    seen.length > 0 &&
      seen.every((url) => url.startsWith(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/`)),
  );
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error(`network included ${env.TELEGRAM_BOT_TOKEN}`);
  });
  await assert.rejects(
    telegram('getMe', {}, env),
    (error) =>
      !error.message.includes(env.TELEGRAM_BOT_TOKEN) &&
      error.message.includes('failed or timed out'),
  );
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      ok: false,
      description: `Rejected ${env.TELEGRAM_BOT_TOKEN} ${env.TELEGRAM_WEBHOOK_SECRET}`,
    }),
  );
  await assert.rejects(
    telegram('getMe', {}, env),
    (error) =>
      !error.message.includes(env.TELEGRAM_BOT_TOKEN) &&
      !error.message.includes(env.TELEGRAM_WEBHOOK_SECRET),
  );
});

test('Mini App menu setup targets only the verified owner private chat and reads its result back', async () => {
  const mock = fixture();
  const result = await configureMiniApp(env, mock.call, { request: publicShell });
  assert.equal(result.menu.type, 'web_app');
  assert.equal(result.menu.web_app.url, env.PUBLIC_URL + '/mini/');
  const mutation = mock.calls.find((call) => call.method === 'setChatMenuButton');
  assert.equal(mutation.body.chat_id, Number(env.OWNER_TELEGRAM_ID));
  assert.equal(mock.calls.at(-1).method, 'getChatMenuButton');
  assert(!mock.calls.some((call) => call.method === 'setWebhook'));
  const check = fixture({ menu: result.menu });
  await configureMiniApp(env, check.call, { check: true, request: publicShell });
  assert(!check.calls.some((call) => call.method.startsWith('set')));
});

test('Mini App setup rejects upstream login redirects and foreign private chats without changing the menu', async () => {
  const redirect = fixture();
  await assert.rejects(
    configureMiniApp(env, redirect.call, {
      request: async () => new Response(null, { status: 302 }),
    }),
    /returned HTTP 302/,
  );
  assert.equal(redirect.calls.length, 0);
  const wrongOwner = fixture({ getChat: { id: 999999, type: 'private' } });
  await assert.rejects(
    configureMiniApp(env, wrongOwner.call, { request: publicShell }),
    /own private chat/,
  );
  assert(!wrongOwner.calls.some((call) => call.method === 'setChatMenuButton'));
});

test('owner menu reset does not depend on a live or configured application URL', async () => {
  const mock = fixture({ menu: { type: 'web_app', web_app: { url: env.PUBLIC_URL + '/mini/' } } });
  await configureMiniApp({ ...env, PUBLIC_URL: '' }, mock.call, {
    reset: true,
    request: () => {
      throw new Error('Reset must not make HTTP request.');
    },
  });
  const mutation = mock.calls.find((call) => call.method === 'setChatMenuButton');
  assert.deepEqual(mutation.body, {
    chat_id: Number(env.OWNER_TELEGRAM_ID),
    menu_button: { type: 'default' },
  });
});

test('discovery leaves an existing webhook untouched and never acknowledges polled updates', async (t) => {
  const messages = [];
  t.mock.method(console, 'log', (...args) => messages.push(args.join(' ')));
  let mock = fixture();
  await discoverTelegram(mock.call);
  assert(
    !mock.calls.some(
      (call) =>
        call.method === 'getUpdates' ||
        call.method.startsWith('set') ||
        call.method.startsWith('delete'),
    ),
  );
  mock = fixture({
    getWebhookInfo: { url: '' },
    getUpdates: [
      {
        message: {
          chat: { id: Number(env.TELEGRAM_CHAT_ID), type: 'supergroup', title: 'Fixture' },
          from: { id: 999999, first_name: 'Observed person', is_bot: false },
        },
      },
    ],
  });
  await discoverTelegram(mock.call);
  const poll = mock.calls.find((call) => call.method === 'getUpdates');
  assert.deepEqual(poll.body, { timeout: 0, limit: 100 });
  assert(!messages.some((message) => message.includes('OWNER_TELEGRAM_ID=999999')));
});

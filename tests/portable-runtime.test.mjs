import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';
import { createAssets } from '../server/assets.ts';
import { createNodeHandler, requestUrl } from '../server/http.ts';
import { createRuntime, publicOrigin } from '../server/runtime.ts';
import { createVercelHandler } from '../api/index.ts';
import { createWorker } from '../worker/index.ts';
import { databaseSchema, postgresEnvironmentConfig } from '../worker/database.ts';
import { PostgresRuntimeStore } from '../server/postgres-store.ts';
import { createPortableAdmin } from '../server/admin.ts';
import { HttpError, readBody } from '../worker/http.ts';
import { TelegramAdminService } from '../worker/telegram-admin.ts';

const source = { PUBLIC_URL: 'https://watchtower.example', CRON_SECRET: 's'.repeat(32) };

if (process.env.TEST_POSTGRES_URL) {
  const database = new URL(process.env.TEST_POSTGRES_URL);
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)
  )
    throw new Error('TEST_POSTGRES_URL must point to a disposable loopback PostgreSQL database.');
}

function memoryStore() {
  const data = new Map();
  const store = {
    get: async (key) => data.get(key),
    put: async (key, value) => data.set(key, structuredClone(value)),
    delete: async (key) => data.delete(key),
    list: async ({ prefix }) => new Map([...data].filter(([key]) => key.startsWith(prefix))),
    setAlarm: async (time) => data.set('$alarm', time),
    deleteAlarm: async () => data.delete('$alarm'),
  };
  let busy = false;
  return {
    store,
    async run(_namespace, callback) {
      if (busy) return { acquired: false };
      busy = true;
      try {
        return { acquired: true, value: await callback(store) };
      } finally {
        busy = false;
      }
    },
  };
}

test('canonical public origin rejects credentials, paths, and insecure production URLs', () => {
  assert.equal(publicOrigin(source), source.PUBLIC_URL);
  assert.equal(publicOrigin({ WORKER_URL: source.PUBLIC_URL }), source.PUBLIC_URL);
  assert.equal(
    publicOrigin({ PUBLIC_URL: 'http://localhost:3000', DEV_MODE: 'true' }),
    'http://localhost:3000',
  );
  for (const PUBLIC_URL of [
    'http://watchtower.example',
    'https://user:pass@example.com',
    'https://example.com/path',
    'https://example.com/?x=1',
  ])
    assert.throws(() => publicOrigin({ PUBLIC_URL }));
  assert.throws(() =>
    publicOrigin({ PUBLIC_URL: 'http://localhost:3000', DEV_MODE: 'true' }, false),
  );
  assert.throws(() => requestUrl('//evil.example/path', source.PUBLIC_URL));
  assert.throws(() => requestUrl('/\\evil.example/path', source.PUBLIC_URL));
  assert.equal(
    requestUrl('/api/overview?x=1', source.PUBLIC_URL).href,
    `${source.PUBLIC_URL}/api/overview?x=1`,
  );
});

test('static adapter serves HEAD and SPA paths while excluding traversal, symlinks, and missing assets', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'watchtower-assets-'));
  const root = join(temporary, 'dist');
  try {
    await mkdir(root);
    await writeFile(join(root, 'index.html'), '<html><head></head><body>app</body></html>');
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'main.js'), 'export const ready = true;');
    await writeFile(join(root, 'assets', 'main.js.map'), 'private source map');
    await writeFile(join(root, 'secret.json'), '{"secret":true}');
    await writeFile(join(temporary, 'secret.txt'), 'private');
    await symlink(join(temporary, 'secret.txt'), join(root, 'assets', 'escaped.js'));
    const assets = createAssets(root);
    const get = (path, method = 'GET') =>
      assets.fetch(new Request(`${source.PUBLIC_URL}${path}`, { method }));
    assert.equal(
      await (await get('/settings')).text(),
      '<html><head></head><body>app</body></html>',
    );
    const head = await get('/assets/main.js', 'HEAD');
    assert.equal(head.headers.get('Content-Type'), 'text/javascript; charset=utf-8');
    assert.equal(head.headers.get('Content-Length'), '26');
    assert.equal(await head.text(), '');
    for (const path of [
      '/assets/escaped.js',
      '/assets/main.js.map',
      '/secret.json',
      '/.env',
      '/%2e%2e%2fsecret.txt',
      '/missing.js',
      '/%00',
    ])
      assert.equal((await get(path)).status, 404, path);
    assert.equal((await get('/assets/main.js', 'POST')).status, 405);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('Node HTTP adapter preserves bodies and cookies while ignoring forwarded origin headers', async () => {
  const observed = [];
  const server = createServer(
    createNodeHandler({
      origin: source.PUBLIC_URL,
      env: { DEV_MODE: 'false' },
      async fetch(request) {
        observed.push({ url: request.url, body: await request.text() });
        const headers = new Headers({ 'Content-Type': 'application/json' });
        headers.append('Set-Cookie', 'first=1; Path=/');
        headers.append('Set-Cookie', 'second=2; Path=/');
        return new Response(JSON.stringify(observed.at(-1)), { headers });
      },
    }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${address}/telegram/webhook?query=kept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Host': 'evil.example',
        'X-Forwarded-Proto': 'http',
      },
      body: '{"update_id":1}',
    });
    assert.deepEqual(await response.json(), {
      url: `${source.PUBLIC_URL}/telegram/webhook?query=kept`,
      body: '{"update_id":1}',
    });
    assert.equal(response.headers.getSetCookie().length, 2);
    const head = await fetch(`${address}/api/overview`, { method: 'HEAD' });
    assert.equal(await head.text(), '');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Vercel Web handler retains original routes, query, and raw body with canonical origin', async () => {
  const handle = createVercelHandler(() => ({
    origin: source.PUBLIC_URL,
    async fetch(request) {
      return Response.json({ url: request.url, body: await request.text() });
    },
  }));
  const response = await handle(
    new Request('https://deployment.vercel.app/telegram/webhook?x=1', {
      method: 'POST',
      body: '{"untouched": "spacing matters"}',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'evil.example' },
    }),
  );
  assert.deepEqual(await response.json(), {
    url: `${source.PUBLIC_URL}/telegram/webhook?x=1`,
    body: '{"untouched": "spacing matters"}',
  });
});

test('bounded scheduler awaits sequential leased work and resumes with the supplied cursor', async () => {
  const groups = ['-1001111111111', '-1002222222222', '-1003333333333'].map((chat_id) => ({
    chat_id,
    status: 'active',
  }));
  const directory = {
    active: async () => groups,
    get: async (chatId) => groups.find((g) => g.chat_id === chatId),
    session: async (callback) => callback(),
  };
  const visited = [];
  let concurrent = 0;
  const worker = createWorker(
    () => ({ fetch: async () => new Response('ok') }),
    () => directory,
    async (env) => {
      assert.equal(++concurrent, 1);
      await delay(5);
      visited.push(env.TELEGRAM_CHAT_ID);
      concurrent--;
      if (env.TELEGRAM_CHAT_ID === groups[1].chat_id) throw new Error('temporary provider failure');
    },
  );
  const first = await worker.scheduledBounded(
    { TELEGRAM_CHAT_ID: groups[0].chat_id },
    { maxGroups: 2 },
  );
  assert.deepEqual(first, { groups: 3, attempted: 2, failed: 1, deferred: 1, cursor: 2 });
  const next = await worker.scheduledBounded(
    { TELEGRAM_CHAT_ID: groups[0].chat_id },
    { cursor: first.cursor, maxGroups: 1 },
  );
  assert.equal(next.cursor, 0);
  assert.deepEqual(
    visited,
    groups.map((g) => g.chat_id),
  );
});

test('cron rejects invalid callers and awaits its full batch before returning', async () => {
  const persistence = memoryStore();
  let calls = 0;
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const runtime = createRuntime(source, {
    persistence,
    admin: { fetch: async () => new Response(), alarm: async () => {} },
    worker: {
      fetch: async () => new Response('app'),
      async scheduledBounded(_env, options) {
        calls++;
        if (!options.cleanup) await barrier;
        return {
          groups: 2,
          attempted: 1,
          failed: 0,
          deferred: 1,
          cursor: (options.cursor + 1) % 2,
        };
      },
    },
  });
  const request = (authorization, method = 'GET') =>
    new Request(`${source.PUBLIC_URL}/api/cron`, {
      method,
      headers: { Authorization: authorization },
    });
  assert.equal((await runtime.fetch(request(''))).status, 401);
  assert.equal((await runtime.fetch(request(`Bearer ${source.CRON_SECRET}`, 'POST'))).status, 405);
  assert.equal(calls, 0);
  let returned = false;
  const pending = runtime.fetch(request(`Bearer ${source.CRON_SECRET}`)).then((response) => {
    returned = true;
    return response;
  });
  await delay(15);
  assert.equal(returned, false);
  assert.equal(calls, 1);
  release();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).skipped, false);
  assert.equal(await persistence.store.get('workCursor'), 1);
});

test('optional Telegram admin reports unconfigured without a database or Telegram operation', async () => {
  const admin = createPortableAdmin(
    {},
    {
      run: async () => {
        throw new Error('must stay lazy');
      },
    },
  );
  const status = await admin.fetch(new Request('https://admin.internal/status'));
  assert.equal((await status.json()).configured, false);
  const login = await admin.fetch(
    new Request('https://admin.internal/login/start', { method: 'POST', body: '{}' }),
  );
  assert.equal(login.status, 503);
  await admin.alarm();
});

test('portable runtime retains webhook, Mini App, and browser mutation security', async () => {
  const runtime = createRuntime({
    ...source,
    OWNER_TELEGRAM_ID: '999',
    TELEGRAM_BOT_TOKEN: 'not-a-real-bot-token',
    TELEGRAM_WEBHOOK_SECRET: 'webhook-secret',
    BROWSER_AUTH_TOKEN: 'b'.repeat(43),
  });
  const webhook = await runtime.fetch(
    new Request(`${source.PUBLIC_URL}/telegram/webhook`, { method: 'POST', body: '{}' }),
  );
  assert.equal(webhook.status, 401);
  const mini = await runtime.fetch(new Request(`${source.PUBLIC_URL}/mini/api/overview`));
  assert.equal(mini.status, 401);
  const crossOrigin = await runtime.fetch(
    new Request(`${source.PUBLIC_URL}/api/auth/login`, {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        'X-Watchtower-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token: 'b'.repeat(43) }),
    }),
  );
  assert.equal(crossOrigin.status, 403);
});

test(
  'Postgres runtime state survives instances, serializes replicas, and fences stale writes',
  {
    skip: !process.env.TEST_POSTGRES_URL,
  },
  async () => {
    const env = {
      DATABASE_URL: process.env.TEST_POSTGRES_URL,
      DEV_MODE: 'true',
      DATABASE_SSL_MODE: 'disable',
      TELEGRAM_CHAT_ID: `-100${Date.now().toString().slice(-10)}`,
    };
    const schema = databaseSchema(env.TELEGRAM_CHAT_ID);
    const client = new pg.Client(postgresEnvironmentConfig(env));
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      const first = new PostgresRuntimeStore(env);
      const second = new PostgresRuntimeStore(env);
      let release;
      let entered;
      const enteredPromise = new Promise((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise((resolve) => {
        release = resolve;
      });
      const running = first.run('admin', async (store) => {
        await store.put('account', { id: '999', name: 'Owner' });
        await store.setAlarm(12345);
        const active = await client.query(
          `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND query LIKE '%watchtower_runtime%'`,
        );
        assert.equal(active.rows[0].count, 0, 'network work must not hold an idle transaction');
        entered();
        await barrier;
      });
      await enteredPromise;
      assert.deepEqual(await second.run('admin', async () => assert.fail('replica overlapped')), {
        acquired: false,
      });
      release();
      await running;
      await assert.rejects(
        second.run('admin', async (store) => {
          assert.deepEqual(await store.get('account'), { id: '999', name: 'Owner' });
          assert.equal(await store.get('$alarm'), 12345);
          // Expiry permits a replacement; the old holder cannot write or release it.
          await client.query(
            `UPDATE "${schema}"."watchtower_runtime_leases" SET owner='replacement' WHERE namespace='admin'`,
          );
          await assert.rejects(store.put('account', { id: 'stale' }), /replaced/);
          await client.query(
            `UPDATE "${schema}"."watchtower_runtime_leases" SET owner='' ,expires_at=0 WHERE namespace='admin'`,
          );
        }),
        /replaced/,
      );
      const account = await client.query(
        `SELECT value FROM "${schema}"."watchtower_runtime" WHERE namespace='admin' AND key='account'`,
      );
      assert.equal(account.rows[0].value.id, '999');
    } finally {
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client.end();
    }
  },
);

test('explicit dashboard host preserves browser mutation origin in Node and Vercel', async () => {
  const dashboard = 'https://owner.watchtower.example';
  const runtime = createRuntime(
    { ...source, DASHBOARD_URL: dashboard },
    {
      worker: {
        fetch: async (request) =>
          Response.json({ url: request.url, origin: request.headers.get('Origin') }),
      },
    },
  );
  const server = createServer(createNodeHandler(runtime));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: '127.0.0.1',
          port: server.address().port,
          path: '/api/settings',
          method: 'POST',
          headers: {
            Host: new URL(dashboard).host,
            Origin: dashboard,
            'X-Forwarded-Host': 'evil.example',
          },
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
          response.on('error', reject);
        },
      );
      request.on('error', reject);
      request.end('{}');
    });
    assert.deepEqual(response, { url: `${dashboard}/api/settings`, origin: dashboard });
    const vercel = createVercelHandler(() => runtime);
    const alias = await vercel(
      new Request(`${dashboard}/api/settings`, { headers: { Origin: dashboard } }),
    );
    assert.equal((await alias.json()).url, `${dashboard}/api/settings`);
    const untrusted = await vercel(
      new Request('https://evil.example/api/settings', {
        headers: { 'X-Forwarded-Host': new URL(dashboard).host },
      }),
    );
    assert.equal((await untrusted.json()).url, `${source.PUBLIC_URL}/api/settings`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Node streams enforce chunked body limits without losing the 413 response', async () => {
  const server = createServer(
    createNodeHandler({
      origin: source.PUBLIC_URL,
      env: { DEV_MODE: 'false' },
      async fetch(request) {
        try {
          await readBody(request, 8);
          return new Response('accepted');
        } catch (error) {
          return new Response(error.message, {
            status: error instanceof HttpError ? error.status : 500,
          });
        }
      },
    }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: '127.0.0.1',
          port: server.address().port,
          method: 'POST',
          path: '/api/upload',
          headers: { 'Transfer-Encoding': 'chunked' },
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () =>
            resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }),
          );
          response.on('error', reject);
        },
      );
      request.on('error', reject);
      request.write('123456789');
      // Keep the upload open: cancellation must not wait for the client to finish.
    });
    assert.deepEqual(response, { status: 413, body: 'Request is too large.' });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test(
  'an expired runtime holder cannot write or release a replacement lease',
  { skip: !process.env.TEST_POSTGRES_URL },
  async () => {
    const env = {
      DATABASE_URL: process.env.TEST_POSTGRES_URL,
      DATABASE_SSL_MODE: 'disable',
      DEV_MODE: 'true',
      TELEGRAM_CHAT_ID: `-100${Date.now().toString().slice(-10)}1`,
    };
    const schema = databaseSchema(env.TELEGRAM_CHAT_ID);
    const client = new pg.Client(postgresEnvironmentConfig(env));
    await client.connect();
    const barrier = () => {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      return { promise, release };
    };
    const originalEntered = barrier(),
      originalExit = barrier(),
      replacementEntered = barrier(),
      replacementExit = barrier();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      const original = new PostgresRuntimeStore(env).run('admin', async (store) => {
        await store.setAlarm(1234);
        originalEntered.release();
        await originalExit.promise;
        await store.put('account', { id: 'stale' });
      });
      const originalFailure = assert.rejects(original, /replaced/);
      await originalEntered.promise;
      await client.query(
        `UPDATE "${schema}"."watchtower_runtime_leases" SET expires_at=0 WHERE namespace='admin'`,
      );
      const replacement = new PostgresRuntimeStore(env).run('admin', async (store) => {
        assert.equal(await store.get('$alarm'), 1234);
        await store.put('account', { id: 'replacement' });
        replacementEntered.release();
        await replacementExit.promise;
      });
      await replacementEntered.promise;
      originalExit.release();
      await originalFailure;
      assert.deepEqual(
        await new PostgresRuntimeStore(env).run('admin', async () =>
          assert.fail('stale release cleared replacement lease'),
        ),
        { acquired: false },
      );
      replacementExit.release();
      await replacement;
      await new PostgresRuntimeStore(env).run('admin', async (store) =>
        assert.deepEqual(await store.get('account'), { id: 'replacement' }),
      );
    } finally {
      originalExit.release();
      replacementExit.release();
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client.end();
    }
  },
);

test(
  'encrypted admin login, session, queued job and alarm survive portable service replacement',
  { skip: !process.env.TEST_POSTGRES_URL },
  async () => {
    const env = {
      DATABASE_URL: process.env.TEST_POSTGRES_URL,
      DATABASE_SSL_MODE: 'disable',
      DEV_MODE: 'true',
      TELEGRAM_CHAT_ID: `-100${Date.now().toString().slice(-10)}2`,
      OWNER_TELEGRAM_ID: '999',
      TELEGRAM_API_ID: '123',
      TELEGRAM_API_HASH: 'a'.repeat(32),
      TELEGRAM_SESSION_KEY: '1'.repeat(64),
    };
    const schema = databaseSchema(env.TELEGRAM_CHAT_ID);
    const client = new pg.Client(postgresEnvironmentConfig(env));
    await client.connect();
    let deleted = 0,
      completed = 0;
    const factory = async (initialSession) => {
      let session = initialSession;
      return {
        connect: async () => {},
        close: async () => {},
        save: () => session,
        sendCode: async () => {
          session = 'pending-session-secret';
          return 'login-hash';
        },
        signIn: async () => {
          assert.equal(session, 'pending-session-secret');
          session = 'owner-session-secret';
        },
        me: async () => ({ id: env.OWNER_TELEGRAM_ID, name: 'Owner' }),
        deleteHistory: async () => {
          assert.equal(session, 'owner-session-secret');
          deleted++;
          return 0;
        },
      };
    };
    const createService = (store, environment) =>
      new TelegramAdminService(
        store,
        environment,
        factory,
        async () => {
          completed++;
        },
        async () => {},
      );
    const portable = () => createPortableAdmin(env, new PostgresRuntimeStore(env), createService);
    const request = (path, body) =>
      new Request(`https://admin.internal${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      const start = await portable().fetch(request('/login/start', { phone: '+12025550123' }));
      assert.equal(start.status, 200);
      assert.equal((await start.json()).loginStep, 'code');
      const pending = await client.query(
        `SELECT value FROM "${schema}"."watchtower_runtime" WHERE namespace='admin' AND key='login'`,
      );
      assert.ok(Array.isArray(pending.rows[0].value.iv));
      assert.ok(!JSON.stringify(pending.rows[0].value).includes('pending-session-secret'));
      const signedIn = await portable().fetch(request('/login/code', { value: '12345' }));
      assert.equal(signedIn.status, 200);
      assert.equal((await signedIn.json()).connected, true);
      const vault = await client.query(
        `SELECT value FROM "${schema}"."watchtower_runtime" WHERE namespace='admin' AND key='vault'`,
      );
      assert.ok(Array.isArray(vault.rows[0].value.data));
      assert.ok(!JSON.stringify(vault.rows[0].value).includes('owner-session-secret'));
      const queued = await portable().fetch(
        request('/queue', {
          chatId: env.TELEGRAM_CHAT_ID,
          userId: '1234',
          name: 'Fixture',
          throughMessageId: 7,
        }),
      );
      assert.equal(queued.status, 202);
      const job = await queued.json();
      await new PostgresRuntimeStore(env).run('admin', async (store) => {
        assert.ok(await store.get('$alarm'));
        await store.put(`job:${job.id}`, { ...job, nextAt: Date.now() - 1 });
        await store.setAlarm(Date.now() - 1);
      });
      await portable().alarm();
      assert.equal(deleted, 1);
      assert.equal(completed, 1);
      await new PostgresRuntimeStore(env).run('admin', async (store) => {
        assert.equal((await store.get(`job:${job.id}`)).status, 'complete');
        assert.equal(await store.get('$alarm'), undefined);
      });
    } finally {
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client.end();
    }
  },
);

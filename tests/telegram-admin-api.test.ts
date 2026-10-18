import { env } from 'cloudflare:workers';
import { runInDurableObject, reset } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { createWorker } from '../worker/index';
import { GroupService } from '../worker/group';
import { SqliteDatabase } from '../worker/database';
import { acknowledgeHistoryCleanup } from '../worker/telegram-admin';
import type { Env } from '../worker/env';
import type { HistoryCleanup } from '../shared/telegram-admin';

afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
});
function adminBinding(fetch: (request: Request) => Promise<Response>) {
  return {
    idFromName: () => 'owner',
    get: () => ({
      fetch: (url: Request | string, init?: RequestInit) =>
        fetch(url instanceof Request ? url : new Request(url, init)),
    }),
  } as unknown as DurableObjectNamespace;
}
const request = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(
    `http://127.0.0.1${path}`,
    body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Watchtower-Request': '1', ...headers },
          body: JSON.stringify(body),
        },
  );

it('requires owner authentication and mutation protection for admin login, and hides the internal queue', async () => {
  const fetch = vi.fn(async (_request: Request) => Response.json({ connected: false }));
  const config = {
    ...env,
    ACCESS_TEAM_DOMAIN: 'https://example.cloudflareaccess.com',
    ACCESS_AUD: 'test-audience',
    TELEGRAM_ADMIN: adminBinding(fetch),
  } as Env;
  const worker = createWorker();
  expect(
    (await worker.fetch(new Request('https://example.com/api/telegram-admin/status'), config))
      .status,
  ).toBe(401);
  expect(
    (
      await worker.fetch(
        new Request('http://127.0.0.1/api/telegram-admin/login/start', { method: 'POST' }),
        config,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await worker.fetch(
        request('/api/telegram-admin/login/start', {}, { Origin: 'https://evil.example' }),
        config,
      )
    ).status,
  ).toBe(403);
  expect((await worker.fetch(request('/api/telegram-admin/queue', {}), config)).status).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
  const status = await worker.fetch(request('/api/telegram-admin/status'), config);
  expect(status.status).toBe(200);
  expect(status.headers.get('Cache-Control')).toBe('no-store');
  expect(status.headers.get('Content-Security-Policy')).toContain("connect-src 'self'");
  expect(new URL(fetch.mock.calls[0][0].url).pathname).toBe('/status');
});

it('queues only the selected struck user after confirmation and leaves deletion records untouched', async () => {
  const stub = env.GROUPS.get(env.GROUPS.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (_instance, state) => {
    const db = new SqliteDatabase(state);
    await db.exec("INSERT INTO users(user_id,name,strikes,last_seen) VALUES('42','Sender',3,1)");
    await db.exec(
      "INSERT INTO messages(id,user_id,user_name,text,sent_at,status,telegram_revision) VALUES(17,'42','Sender','text',1,'spam',1)",
    );
    const fetch = vi.fn(async (r: Request) =>
      Response.json({ ...((await r.json()) as object), status: 'queued' }, { status: 202 }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, result: { status: 'kicked' } })),
    );
    const service = new GroupService(db, { ...env, TELEGRAM_ADMIN: adminBinding(fetch) });
    expect(
      (await service.fetch(request('/api/users/42/delete-history', { confirmUserId: '43' })))
        .status,
    ).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    const response = await service.fetch(
      request('/api/users/42/delete-history', { confirmUserId: '42' }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      chatId: env.TELEGRAM_CHAT_ID,
      userId: '42',
      throughMessageId: 17,
    });
    expect(
      (await db.exec<{ deleted: number }>('SELECT deleted FROM messages WHERE id=17'))[0].deleted,
    ).toBe(0);
    await db.exec("UPDATE users SET strikes=0 WHERE user_id='42'");
    expect(
      (await service.fetch(request('/api/users/42/delete-history', { confirmUserId: '42' })))
        .status,
    ).toBe(409);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

it('protects administrators and exempt users before contacting the admin-account queue', async () => {
  const stub = env.GROUPS.get(env.GROUPS.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (_instance, state) => {
    const db = new SqliteDatabase(state);
    await db.exec("INSERT INTO users(user_id,name,strikes,last_seen) VALUES('42','Admin',1,1)");
    const fetch = vi.fn(async () => Response.json({}));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, result: { status: 'administrator' } })),
    );
    const service = new GroupService(db, { ...env, TELEGRAM_ADMIN: adminBinding(fetch) });
    expect(
      (await service.fetch(request('/api/users/42/delete-history', { confirmUserId: '42' })))
        .status,
    ).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});

it('acknowledges confirmed history once, preserving later and unrelated records and all strike state', async () => {
  const stub = env.GROUPS.get(env.GROUPS.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (_instance, state) => {
    const db = new SqliteDatabase(state);
    await db.exec(
      "INSERT INTO users(user_id,name,strikes,banned,last_seen) VALUES('42','Sender',3,1,1)",
    );
    for (const [id, userId, sentAt] of [
      [1, '42', 1],
      [2, '43', 1],
      [3, '42', 2000],
      [4, '42', 1],
    ] as const)
      await db.exec(
        "INSERT INTO messages(id,user_id,user_name,text,sent_at,status,telegram_revision) VALUES(?,?,'Sender','text',?,'spam',1)",
        id,
        userId,
        sentAt,
      );
    const job = {
      id: 'confirmed-cleanup',
      userId: '42',
      chatId: env.TELEGRAM_CHAT_ID,
      throughMessageId: 3,
      requestedAt: 1000,
    } as HistoryCleanup;
    await acknowledgeHistoryCleanup(db, job);
    await acknowledgeHistoryCleanup(db, job);
    expect(await db.exec('SELECT id,deleted FROM messages ORDER BY id')).toEqual([
      { id: 1, deleted: 1 },
      { id: 2, deleted: 0 },
      { id: 3, deleted: 0 },
      { id: 4, deleted: 0 },
    ]);
    expect(await db.exec('SELECT strikes,banned FROM users')).toEqual([{ strikes: 3, banned: 1 }]);
    expect(await db.exec('SELECT kind FROM audit')).toEqual([{ kind: 'history_cleanup' }]);
  });
});

import { env } from 'cloudflare:workers';
import { runInDurableObject, runDurableObjectAlarm, reset } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../shared/types';
import { initializePostgres } from '../worker/storage';
import { initializeDirectory, provision, groupEnv } from '../worker/directory';
import { PostgresDatabase } from '../worker/database';
import { GroupService } from '../worker/group';
import type { AdminClient, AdminClientFactory } from '../worker/telegram-admin-client';
import type { TelegramAdmin } from '../worker/telegram-admin';

afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
});
describe.skipIf(!env.TEST_POSTGRES_URL)(
  'admin cleanup through the actual Durable Object and Postgres',
  () => {
    it('confirms cleanup in a second group without changing overlapping root-group records', async () => {
      expect(new URL(String(env.TEST_POSTGRES_URL)).hostname).toBe('127.0.0.1');
      const db = new PostgresDatabase(env),
        second = '-1007777333';
      await initializePostgres(env);
      await initializeDirectory(db, env);
      await db.transaction(async () => {
        await provision(db.forGroup(second), defaultSettings);
        await db.exec(
          `INSERT INTO ${db.table('watchtower_groups')} (chat_id,title,chat_type,status,provisioned,created_at) VALUES (?,'Test group','supergroup','active',1,1) ON CONFLICT (chat_id) DO UPDATE SET status='active'`,
          second,
        );
        for (const groupDb of [db, db.forGroup(second)]) {
          await groupDb.exec(
            `TRUNCATE ${['users', 'messages', 'audit'].map((table) => groupDb.table(table)).join(',')}`,
          );
          await groupDb.exec(
            'UPDATE config SET value=? WHERE id=1',
            JSON.stringify(defaultSettings),
          );
          await groupDb.exec(
            "INSERT INTO users (user_id,name,strikes,banned,last_seen) VALUES ('42','Struck user',3,1,1)",
          );
          await groupDb.exec(
            "INSERT INTO messages (id,user_id,user_name,text,sent_at,status,telegram_revision) VALUES (17,'42','Struck user','Old message',1,'spam',1)",
          );
        }
      });
      const client: AdminClient = {
        connect: async () => {},
        close: async () => {},
        save: () => 'test-session',
        sendCode: async () => 'test-code-hash',
        signIn: async () => {},
        password: async () => {},
        me: async () => ({ id: env.OWNER_TELEGRAM_ID, name: 'Test owner' }),
        logout: async () => {},
        deleteHistory: vi.fn(async () => 0),
      };
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ ok: true, result: { status: 'kicked' } })),
      );
      const stub = env.TELEGRAM_ADMIN!.get(env.TELEGRAM_ADMIN!.idFromName(crypto.randomUUID()));
      await runInDurableObject(stub, (instance: TelegramAdmin) => {
        // Replace only the Telegram network boundary; storage, routing, validation,
        // encryption, alarms and the Postgres acknowledgement use production code.
        (instance as unknown as { service: { factory: AdminClientFactory } }).service.factory =
          async () => client;
      });
      const post = (path: string, body: unknown) =>
        stub.fetch(`https://admin.internal${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      expect((await post('/login/start', { phone: '+15551234567' })).status).toBe(200);
      expect((await post('/login/code', { value: '12345' })).status).toBe(200);
      const namespace = {
        idFromName: () => 'owner',
        get: () => stub,
      } as unknown as DurableObjectNamespace;
      const service = new GroupService(db.forGroup(second), {
        ...groupEnv(env, second),
        TELEGRAM_ADMIN: namespace,
      });
      const response = await service.fetch(
        new Request('https://group.internal/api/users/42/delete-history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmUserId: '42' }),
        }),
      );
      expect(response.status).toBe(202);
      await runDurableObjectAlarm(stub);
      expect(client.deleteHistory).toHaveBeenCalledExactlyOnceWith(second, '42');
      await db.session(async () => {
        expect(
          (await db.exec<{ deleted: number }>('SELECT deleted FROM messages WHERE id=17'))[0]
            .deleted,
        ).toBe(0);
        expect(
          (
            await db
              .forGroup(second)
              .exec<{ deleted: number }>('SELECT deleted FROM messages WHERE id=17')
          )[0].deleted,
        ).toBe(1);
        expect(await db.forGroup(second).exec('SELECT strikes,banned FROM users')).toEqual([
          { strikes: 3, banned: 1 },
        ]);
        expect(await db.exec('SELECT kind FROM audit')).toEqual([]);
        expect(await db.forGroup(second).exec('SELECT kind FROM audit')).toEqual([
          { kind: 'history_cleanup' },
        ]);
      });
      const status = (await (
        await stub.fetch(`https://admin.internal/jobs?chatId=${second}`)
      ).json()) as { jobs: { status: string }[] };
      expect(status.jobs[0].status).toBe('complete');
    });
  },
);

import type { Env } from '../worker/env';
import { json } from '../worker/http';
import { createTelegramAdminService } from '../worker/telegram-admin';
import { PostgresRuntimeStore, type RuntimeStore } from './postgres-store';

export function createPortableAdmin(
  env: Env,
  persistence = new PostgresRuntimeStore(env),
  createService: (
    store: RuntimeStore,
    env: Env,
  ) => Pick<
    ReturnType<typeof createTelegramAdminService>,
    'handle' | 'alarm'
  > = createTelegramAdminService,
) {
  const configured = () =>
    /^\d+$/.test(env.TELEGRAM_API_ID || '') &&
    /^[a-f0-9]{32}$/i.test(env.TELEGRAM_API_HASH || '') &&
    /^[a-f0-9]{64}$/i.test(env.TELEGRAM_SESSION_KEY || '');
  return {
    async fetch(request: Request): Promise<Response> {
      if (!configured()) {
        const path = new URL(request.url).pathname;
        if (request.method === 'GET' && path === '/status')
          return json({
            configured: false,
            connected: false,
            account: null,
            loginStep: 'phone',
            loginExpiresAt: null,
          });
        if (request.method === 'GET' && path === '/jobs') return json({ jobs: [] });
        return json(
          { error: 'Configure TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_SESSION_KEY.' },
          503,
        );
      }
      const result = await persistence.run('admin', (store) =>
        createService(store, env).handle(request),
      );
      return result.acquired
        ? result.value
        : json({ error: 'Another Telegram admin operation is running. Please retry.' }, 409);
    },
    async alarm() {
      if (!configured()) return;
      await persistence.run('admin', async (store) => {
        const next = await store.get<number>('$alarm');
        if (next && next <= Date.now()) await createService(store, env).alarm();
      });
    },
  };
}

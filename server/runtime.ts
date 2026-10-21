import { resolve } from 'node:path';
import { secureEqual } from '../worker/auth';
import type { Env } from '../worker/env';
import { HttpError, json } from '../worker/http';
import { createWorker } from '../worker/index';
import { createAssets } from './assets';
import { createPortableAdmin } from './admin';
import { PostgresRuntimeStore } from './postgres-store';

type Source = Record<string, string | undefined>;
type Options = {
  assetsDirectory?: string;
  allowDevelopment?: boolean;
  worker?: ReturnType<typeof createWorker>;
  persistence?: PostgresRuntimeStore;
  admin?: ReturnType<typeof createPortableAdmin>;
  schedulerGroups?: number;
};

export function publicOrigin(source: Source, allowDevelopment = true) {
  const configured = source.PUBLIC_URL || source.WORKER_URL;
  if (!configured)
    throw new Error('Configure PUBLIC_URL with the canonical HTTPS application URL.');
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('PUBLIC_URL must be an absolute HTTPS URL.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(allowDevelopment && source.DEV_MODE === 'true' && local && url.protocol === 'http:')) ||
    (!allowDevelopment && source.DEV_MODE === 'true')
  )
    throw new Error(
      'PUBLIC_URL must be a canonical HTTPS origin; loopback HTTP is development only.',
    );
  return url.origin;
}

export function createRuntime(source: Source = process.env, options: Options = {}) {
  const origin = publicOrigin(source, options.allowDevelopment !== false);
  // An optional Access hostname is an explicit trusted alias of this deployment.
  // Select it only from the actual Host, never forwarded host/protocol headers.
  const dashboardOrigin = source.DASHBOARD_URL
    ? publicOrigin({ PUBLIC_URL: source.DASHBOARD_URL }, false)
    : origin;
  const requestOrigin = (host: string | undefined) =>
    host?.toLowerCase() === new URL(dashboardOrigin).host ? dashboardOrigin : origin;
  const env = {
    DEV_MODE: 'false',
    TELEGRAM_CHAT_ID: '',
    OWNER_TELEGRAM_ID: '',
    ADMIN_EMAIL: '',
    ACCESS_TEAM_DOMAIN: '',
    ACCESS_AUD: '',
    ...Object.fromEntries(Object.entries(source).filter(([, value]) => typeof value === 'string')),
    PUBLIC_URL: origin,
    ASSETS: createAssets(options.assetsDirectory || resolve(process.cwd(), 'dist')),
  } as unknown as Env;
  const worker = options.worker || createWorker();
  // An unconfigured application can still serve its shell, auth configuration, and health.
  const database = !!(env.DATABASE_URL || env.PLANETSCALE_DATABASE_URL);
  const persistence =
    options.persistence ||
    (database && env.TELEGRAM_CHAT_ID ? new PostgresRuntimeStore(env) : undefined);
  const admin = options.admin || (persistence ? createPortableAdmin(env, persistence) : undefined);
  if (admin) env.TELEGRAM_ADMIN_SERVICE = admin;

  async function tick() {
    if (!persistence)
      throw new HttpError(503, 'Configure DATABASE_URL and TELEGRAM_CHAT_ID before scheduling.');
    let adminFailed = false;
    try {
      await admin?.alarm();
    } catch {
      adminFailed = true;
    }
    const result = await persistence.run('scheduler', async (store) => {
      const cursor = (await store.get<number>('workCursor')) || 0;
      const work = await worker.scheduledBounded(env, {
        cursor,
        maxGroups: options.schedulerGroups || 4,
        durationMs: options.schedulerGroups === 1 ? 45_000 : 120_000,
      });
      await store.put('workCursor', work.cursor);
      // Retention catches up after a restart. Each daily pass has a durable cursor,
      // so large group registries resume on the next minute instead of fanout.
      const day = new Date(Date.now() - (3 * 60 + 17) * 60_000).toISOString().slice(0, 10);
      let retention = await store.get<{ day: string; cursor: number; remaining: number }>(
        'retention',
      );
      if (!retention || retention.day !== day)
        retention = { day, cursor: 0, remaining: Number.MAX_SAFE_INTEGER };
      let cleanup;
      if (retention.remaining > 0) {
        cleanup = await worker.scheduledBounded(env, {
          cleanup: true,
          cursor: retention.cursor,
          maxGroups: Math.min(20, retention.remaining),
          durationMs: 15_000,
        });
        // Failed groups are retried in the next complete pass; never mark a failed
        // daily pass complete. Cleanup and work both retain their group work lease.
        retention = {
          day,
          cursor: cleanup.cursor,
          remaining: cleanup.failed
            ? cleanup.groups
            : Math.max(0, Math.min(retention.remaining, cleanup.groups) - cleanup.attempted),
        };
        await store.put('retention', retention);
      }
      return { work, cleanup, adminFailed };
    });
    return result.acquired
      ? { skipped: false as const, ...result.value }
      : { skipped: true as const };
  }

  return {
    env,
    origin,
    requestOrigin,
    tick,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== '/api/cron') return worker.fetch(request, env);
      const secret = source.CRON_SECRET || '';
      if (request.method !== 'GET') return json({ error: 'GET only.' }, 405);
      if (secret.length < 32)
        return json({ error: 'Configure a CRON_SECRET of at least 32 characters.' }, 503);
      if (!(await secureEqual(request.headers.get('Authorization') || '', `Bearer ${secret}`)))
        return json({ error: 'Invalid cron authorization.' }, 401);
      try {
        const result = await tick();
        const failed =
          !result.skipped && (result.work.failed || result.cleanup?.failed || result.adminFailed);
        return json(result, failed ? 503 : 200);
      } catch {
        return json(
          { error: 'Scheduled work failed. Saved work will retry on the next tick.' },
          503,
        );
      }
    },
  };
}

export type Runtime = ReturnType<typeof createRuntime>;

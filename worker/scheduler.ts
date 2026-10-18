import { PostgresDatabase, LostWorkLeaseError } from './database';
import { GroupService } from './group';
import type { Env } from './env';

// Cron is the recovery mechanism as well as the batching timer. It never relies on
// browser polling or a response's short waitUntil lifetime to finish provider calls.
export async function runScheduledWork(
  env: Env,
  durationMs = 45_000,
  db = new PostgresDatabase(env),
) {
  const group = new GroupService(db, env);
  const deadline = Date.now() + durationMs;
  try {
    return await db.withWorkLease(async () => {
      // Production gets a fresh CPU allowance on the next cron invocation.
      const bounded = env.DEV_MODE !== 'true';
      for (let batches = 0; batches < (bounded ? 1 : 20) && (await group.hasDueWork()); batches++) {
        await group.processBatch(bounded);
        if (Date.now() >= deadline) break;
      }
    });
  } catch (e) {
    if (e instanceof LostWorkLeaseError) return false;
    throw e;
  }
}

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
      // Each call checkpoints its own progress. Drain several isolated decisions
      // within the invocation budget instead of limiting production to one message/minute.
      const bounded = env.DEV_MODE !== 'true';
      for (
        let batches = 0;
        batches < 20 && Date.now() < deadline && (await group.hasDueWork());
        batches++
      ) {
        if (Date.now() >= deadline) break;
        await group.processBatch(bounded);
        if (Date.now() >= deadline) break;
      }
    });
  } catch (e) {
    if (e instanceof LostWorkLeaseError) return false;
    throw e;
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroupService } from '../worker/group';
import { runScheduledWork } from '../worker/scheduler';
import type { PostgresDatabase } from '../worker/database';
import type { Env } from '../worker/env';

afterEach(() => vi.restoreAllMocks());
const db = () => ({ withWorkLease: (work: () => Promise<unknown>) => work() }) as PostgresDatabase;

describe('checkpointed single-message scheduling', () => {
  it('drains several production work chunks under the same lease', async () => {
    const due = vi.spyOn(GroupService.prototype, 'hasDueWork');
    due
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const process = vi.spyOn(GroupService.prototype, 'processBatch').mockResolvedValue();
    await runScheduledWork({ DEV_MODE: 'false' } as Env, 45000, db());
    expect(process).toHaveBeenCalledTimes(3);
    expect(process).toHaveBeenCalledWith(true);
  });

  it('stops at the deadline and caps each invocation even when work remains due', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(GroupService.prototype, 'hasDueWork').mockResolvedValue(true);
    const process = vi
      .spyOn(GroupService.prototype, 'processBatch')
      .mockImplementation(async () => {
        now += 23000;
      });
    await runScheduledWork({ DEV_MODE: 'false' } as Env, 45000, db());
    expect(process).toHaveBeenCalledTimes(2);
    process.mockClear().mockImplementation(async () => {});
    await runScheduledWork({ DEV_MODE: 'false' } as Env, 45000, db());
    expect(process).toHaveBeenCalledTimes(20);
  });

  it('does not start another chunk when checking due work consumes the remaining time', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(GroupService.prototype, 'hasDueWork').mockImplementation(async () => {
      now = 45000;
      return true;
    });
    const process = vi.spyOn(GroupService.prototype, 'processBatch').mockResolvedValue();
    await runScheduledWork({ DEV_MODE: 'false' } as Env, 45000, db());
    expect(process).not.toHaveBeenCalled();
  });
});

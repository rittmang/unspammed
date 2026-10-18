import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Env } from '../worker/env';
import type { AdminClient } from '../worker/telegram-admin-client';
import { TelegramAdminService, adminFailure, type AdminStore } from '../worker/telegram-admin';
import { HttpError } from '../worker/http';
import type { HistoryCleanup } from '../shared/telegram-admin';

class Store implements AdminStore {
  values = new Map<string, unknown>();
  alarmAt: number | null = null;
  async get<T>(key: string) {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put<T>(key: string, value: T) {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string) {
    this.values.delete(key);
  }
  async list<T>({ prefix }: { prefix: string }) {
    return new Map(
      [...this.values]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key, structuredClone(value) as T]),
    );
  }
  async setAlarm(time: number) {
    this.alarmAt = time;
  }
  async deleteAlarm() {
    this.alarmAt = null;
  }
}
let store: Store, service: TelegramAdminService, client: AdminClient;
let complete: Mock<(job: HistoryCleanup) => Promise<void>>,
  validate: Mock<(chatId: string, userId: string) => Promise<void>>;
const env = {
  TELEGRAM_API_ID: '12345',
  TELEGRAM_API_HASH: 'a'.repeat(32),
  TELEGRAM_SESSION_KEY: 'b'.repeat(64),
  OWNER_TELEGRAM_ID: '999',
} as Env;
const input = { chatId: '-1001234', userId: '42', name: 'Spam sender', throughMessageId: 17 };
const send = (path: string, body = {}) =>
  service.handle(
    new Request(`https://admin.internal${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
async function connect() {
  expect((await send('/login/start', { phone: '+15551234567' })).status).toBe(200);
  expect((await send('/login/code', { value: '12345' })).status).toBe(200);
}
async function due(job: HistoryCleanup) {
  await store.put(`job:${job.id}`, { ...job, nextAt: 0 });
}
beforeEach(() => {
  store = new Store();
  complete = vi.fn(async () => {});
  validate = vi.fn(async () => {});
  client = {
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    save: () => 'private-mtproto-session',
    sendCode: vi.fn(async () => 'private-phone-code-hash'),
    signIn: vi.fn(async () => {}),
    password: vi.fn(async () => {}),
    me: vi.fn(async () => ({ id: '999', name: 'Owner' })),
    logout: vi.fn(async () => {}),
    deleteHistory: vi.fn(async () => 0),
  };
  service = new TelegramAdminService(store, env, async () => client, complete, validate);
});

describe('Telegram admin account and full-history cleanup', () => {
  it('encrypts login details and sessions, and returns only public connection metadata', async () => {
    await send('/login/start', { phone: '+15551234567' });
    let persisted = JSON.stringify([...store.values]);
    expect(persisted).not.toContain('+15551234567');
    expect(persisted).not.toContain('private-phone-code-hash');
    expect(persisted).not.toContain('private-mtproto-session');
    await send('/login/code', { value: '12345' });
    const status = await service.status();
    expect(status.connected).toBe(true);
    expect(status.account?.id).toBe('999');
    expect(JSON.stringify(status)).not.toContain('private');
    expect(store.values.has('login')).toBe(false);
    persisted = JSON.stringify([...store.values]);
    expect(persisted).not.toContain('private-mtproto-session');
    expect(persisted).not.toContain(env.TELEGRAM_API_HASH);
  });
  it('continues through two-step verification without saving the password', async () => {
    vi.mocked(client.signIn).mockRejectedValueOnce({ errorMessage: 'SESSION_PASSWORD_NEEDED' });
    await send('/login/start', { phone: '+15551234567' });
    const response = await send('/login/code', { value: '12345' });
    expect(((await response.json()) as any).loginStep).toBe('password');
    await send('/login/password', { value: 'private-two-step-password' });
    expect(client.password).toHaveBeenCalledWith('private-two-step-password');
    expect(JSON.stringify([...store.values])).not.toContain('private-two-step-password');
    expect((await service.status()).connected).toBe(true);
  });
  it('signs out an account other than the configured owner', async () => {
    vi.mocked(client.me).mockResolvedValue({ id: '1000', name: 'Someone else' });
    await send('/login/start', { phone: '+15551234567' });
    expect((await send('/login/code', { value: '12345' })).status).toBe(403);
    expect(client.logout).toHaveBeenCalled();
    expect((await service.status()).connected).toBe(false);
    expect(store.values.has('vault')).toBe(false);
  });
  it('expires and erases incomplete logins, without changing connected accounts', async () => {
    await send('/login/start', { phone: '+15551234567' });
    await store.put('loginExpiresAt', 1);
    await service.alarm();
    expect(store.values.has('login')).toBe(false);
    expect((await service.status()).loginStep).toBe('phone');
    expect((await send('/login/code', { value: '12345' })).status).toBe(409);
  });
  it('rate limits login codes and sanitizes errors from Telegram', async () => {
    vi.mocked(client.sendCode).mockRejectedValue(
      new Error('secret phone and session: private-data'),
    );
    const first = await send('/login/start', { phone: '+15551234567' });
    expect(first.status).toBe(502);
    expect(await first.text()).not.toContain('private-data');
    expect((await send('/login/start', { phone: '+15551234567' })).status).toBe(429);
    expect(client.close).toHaveBeenCalled();
  });
  it('requires a connection and protects the owner before queuing', async () => {
    expect((await send('/queue', input)).status).toBe(409);
    await connect();
    expect((await send('/queue', { ...input, userId: '999' })).status).toBe(403);
    expect(client.deleteHistory).not.toHaveBeenCalled();
  });
  it('deduplicates pending requests per user and group, while keeping groups independent', async () => {
    await connect();
    const a = await service.queue(input),
      b = await service.queue(input);
    expect(a.id).toBe(b.id);
    const other = await service.queue({ ...input, chatId: '-1005678' });
    expect(other.id).not.toBe(a.id);
    expect(await service.jobs(input.chatId)).toHaveLength(1);
    expect(client.deleteHistory).not.toHaveBeenCalled();
  });
  it('repeats partial Telegram deletions and marks tracked history only after offset reaches zero', async () => {
    await connect();
    vi.mocked(client.deleteHistory).mockResolvedValueOnce(100).mockResolvedValueOnce(0);
    const job = await service.queue(input);
    await service.alarm();
    expect(complete).not.toHaveBeenCalled();
    expect((await service.jobs(input.chatId))[0].status).toBe('queued');
    await due((await service.jobs(input.chatId))[0]);
    await service.alarm();
    expect(client.deleteHistory).toHaveBeenCalledTimes(2);
    expect(client.deleteHistory).toHaveBeenLastCalledWith(input.chatId, input.userId);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ id: job.id, throughMessageId: 17 }),
    );
    expect((await service.jobs(input.chatId))[0].status).toBe('complete');
    expect(store.alarmAt).toBeNull();
  });
  it('persists a recovery alarm before issuing the destructive API call', async () => {
    await connect();
    vi.mocked(client.deleteHistory).mockImplementation(async () => {
      expect(store.alarmAt).toBeGreaterThan(Date.now());
      expect((await service.jobs(input.chatId))[0].status).toBe('running');
      return 0;
    });
    await service.queue(input);
    await service.alarm();
    expect(complete).toHaveBeenCalledOnce();
  });
  it('honors Telegram flood waits without sleeping or falsely reporting completion', async () => {
    await connect();
    vi.mocked(client.deleteHistory).mockRejectedValue({
      errorMessage: 'FLOOD_WAIT_120',
      seconds: 120,
    });
    await service.queue(input);
    await service.alarm();
    const job = (await service.jobs(input.chatId))[0];
    expect(job.status).toBe('queued');
    expect(job.nextAt).toBeGreaterThanOrEqual(Date.now() + 119000);
    expect(complete).not.toHaveBeenCalled();
    expect(store.alarmAt).toBe(job.nextAt);
  });
  it('revalidates strikes, group membership, and protection before each attempt', async () => {
    await connect();
    await service.queue(input);
    validate.mockRejectedValue(new HttpError(403, 'Administrators are protected.'));
    await service.alarm();
    expect(client.deleteHistory).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect((await service.jobs(input.chatId))[0].status).toBe('failed');
  });
  it('can retry a failed cleanup without reusing a terminal job', async () => {
    await connect();
    const first = await service.queue(input);
    validate.mockRejectedValueOnce(new HttpError(409, 'Reconnect group.'));
    await service.alarm();
    const retry = await service.queue(input);
    expect(retry.id).not.toBe(first.id);
    await service.alarm();
    expect(complete).toHaveBeenCalledOnce();
  });
  it('clears a revoked session and fails the job visibly', async () => {
    await connect();
    await service.queue(input);
    vi.mocked(client.me).mockRejectedValue({ errorMessage: 'SESSION_REVOKED' });
    await service.alarm();
    expect((await service.status()).connected).toBe(false);
    expect(store.values.has('vault')).toBe(false);
    expect((await service.jobs(input.chatId))[0].status).toBe('failed');
    expect(complete).not.toHaveBeenCalled();
  });
  it('retries database acknowledgement failures without falsely marking the job complete', async () => {
    await connect();
    await service.queue(input);
    complete.mockRejectedValueOnce(new Error('Database unavailable'));
    await service.alarm();
    const job = (await service.jobs(input.chatId))[0];
    expect(job.status).toBe('queued');
    await due(job);
    await service.alarm();
    expect((await service.jobs(input.chatId))[0].status).toBe('complete');
  });
  it('revokes the Telegram session and cancels pending cleanup on disconnect', async () => {
    await connect();
    await service.queue(input);
    expect((await send('/disconnect')).status).toBe(200);
    expect(client.logout).toHaveBeenCalledOnce();
    expect(store.values.has('vault')).toBe(false);
    expect((await service.jobs(input.chatId))[0].status).toBe('failed');
    await service.alarm();
    expect(client.deleteHistory).not.toHaveBeenCalled();
  });
  it('does not overwrite an encrypted session when its key cannot decrypt it', async () => {
    await connect();
    const wrong = new TelegramAdminService(
      store,
      { ...env, TELEGRAM_SESSION_KEY: 'c'.repeat(64) },
      async () => client,
      complete,
      validate,
    );
    const before = await store.get('vault');
    const response = await wrong.handle(
      new Request('https://admin.internal/disconnect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(503);
    expect(await store.get('vault')).toEqual(before);
  });
  it('does not expose unrecognized RPC errors', () => {
    expect(
      adminFailure({ errorMessage: 'SECRET_VALUE', message: 'private-password' }).message,
    ).not.toContain('SECRET_VALUE');
  });
  it('constructs and destroys the actual MTProto client in workerd without signing in', async () => {
    const { createAdminClient } = await import('../worker/telegram-admin-client');
    const actual = await createAdminClient('', 12345, 'a'.repeat(32));
    expect(actual.save()).toBe('');
    await actual.close();
  });
});

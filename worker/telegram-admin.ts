import { z } from 'zod';
import type { Env } from './env';
import { HttpError, json, readJson } from './http';
import type { HistoryCleanup, TelegramAdminStatus } from '../shared/telegram-admin';
import type { AdminAccount, AdminClient, AdminClientFactory } from './telegram-admin-client';
import type { Database } from './database';

interface Login {
  phone: string;
  hash: string;
  session: string;
  step: 'code' | 'password';
  expiresAt: number;
}
interface Vault {
  session: string;
  account: AdminAccount;
}
export interface AdminStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  setAlarm(time: number): Promise<unknown>;
  deleteAlarm(): Promise<unknown>;
}
export function adminFailure(error: unknown): {
  message: string;
  retryAfter?: number;
  needsPassword?: boolean;
  revoked?: boolean;
} {
  if (error instanceof HttpError) return { message: error.message };
  const e = error as { errorMessage?: string; seconds?: number };
  const code = String(e?.errorMessage || '');
  if (code === 'SESSION_PASSWORD_NEEDED')
    return { message: 'Enter your Telegram two-step verification password.', needsPassword: true };
  if (/FLOOD_WAIT|FLOOD_PREMIUM_WAIT/.test(code))
    return {
      message: 'Telegram rate limit. Please wait before trying again.',
      retryAfter: Math.min(86400, Math.max(1, Number(e.seconds) || 60)),
    };
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/.test(code))
    return {
      message: 'Your Telegram admin session expired or was revoked. Reconnect your account.',
      revoked: true,
    };
  const messages: Record<string, string> = {
    PHONE_CODE_INVALID: 'That login code is invalid. Try again.',
    PHONE_CODE_EXPIRED: 'That login code expired. Request a new code.',
    PHONE_NUMBER_INVALID: 'Enter your phone number with its country code.',
    PHONE_NUMBER_BANNED: 'Telegram cannot sign in this phone number.',
    PASSWORD_HASH_INVALID: 'That two-step verification password is incorrect.',
    API_ID_INVALID: 'The Telegram API ID or hash is invalid. Check the Worker secrets.',
    CHAT_ADMIN_REQUIRED: 'Your connected account needs Delete messages permission in this group.',
    CHANNEL_PRIVATE: 'Your connected account no longer has access to this group.',
    PARTICIPANT_ID_INVALID: 'Telegram could not resolve this user in the selected group.',
    AUTH_RESTART: 'Telegram restarted authentication. Request a new login code.',
    PHONE_NUMBER_UNOCCUPIED: 'Connect your existing Telegram owner account.',
  };
  // Raw provider errors can contain login credentials or session data.
  return {
    message: messages[code] || 'Telegram admin request failed. Retry or reconnect your account.',
  };
}

export function adminDiagnostic(error: unknown) {
  const e = error as { name?: unknown; errorMessage?: unknown; stack?: unknown };
  return {
    name: typeof e?.name === 'string' && /^[A-Za-z]+$/.test(e.name) ? e.name : 'Error',
    rpc:
      typeof e?.errorMessage === 'string' && /^[A-Z][A-Z0-9_]{0,100}$/.test(e.errorMessage)
        ? e.errorMessage
        : '',
    // Stack frames contain source locations, without the error message or values.
    frames:
      typeof e?.stack === 'string'
        ? e.stack
            .split('\n')
            .filter((line) => /^\s+at /.test(line))
            .slice(0, 8)
            .map((line) => line.replace(/\?.*?(?=\)|$)/g, '').slice(0, 220))
        : [],
  };
}

export class TelegramAdminService {
  constructor(
    private store: AdminStore,
    private env: Env,
    private factory: AdminClientFactory,
    private complete: (job: HistoryCleanup) => Promise<void>,
    private validateGroup: (chatId: string, userId: string) => Promise<void>,
  ) {}
  private configured() {
    return (
      /^\d+$/.test(this.env.TELEGRAM_API_ID || '') &&
      /^[a-f0-9]{32}$/i.test(this.env.TELEGRAM_API_HASH || '') &&
      /^[a-f0-9]{64}$/i.test(this.env.TELEGRAM_SESSION_KEY || '')
    );
  }
  private async key() {
    if (!this.configured())
      throw new HttpError(
        503,
        'Configure TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_SESSION_KEY as Worker secrets.',
      );
    const bytes = Uint8Array.from(this.env.TELEGRAM_SESSION_KEY!.match(/../g)!, (s) =>
      parseInt(s, 16),
    );
    return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  private async seal(key: string, value: unknown) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(key) },
      await this.key(),
      new TextEncoder().encode(JSON.stringify(value)),
    );
    await this.store.put(key, { iv: Array.from(iv), data: Array.from(new Uint8Array(encrypted)) });
  }
  private async open<T>(key: string): Promise<T | undefined> {
    const saved = await this.store.get<{ iv: number[]; data: number[] }>(key);
    if (!saved) return undefined;
    try {
      const data = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: new Uint8Array(saved.iv),
          additionalData: new TextEncoder().encode(key),
        },
        await this.key(),
        new Uint8Array(saved.data),
      );
      return JSON.parse(new TextDecoder().decode(data));
    } catch {
      throw new HttpError(
        503,
        'Cannot unlock the Telegram session. Restore the original session encryption key.',
      );
    }
  }
  private async client<T>(session: string, fn: (client: AdminClient) => Promise<T>) {
    if (!this.configured()) await this.key();
    const client = await this.factory(
      session,
      Number(this.env.TELEGRAM_API_ID),
      this.env.TELEGRAM_API_HASH!,
    );
    try {
      await client.connect();
      return await fn(client);
    } finally {
      await client.close().catch(() => {});
    }
  }
  async status(): Promise<TelegramAdminStatus> {
    const account = await this.store.get<AdminAccount>('account');
    const expiresAt = await this.store.get<number>('loginExpiresAt');
    const activeLogin = !!expiresAt && expiresAt > Date.now();
    return {
      configured: this.configured(),
      connected: !!account,
      account: account || null,
      loginStep: activeLogin
        ? (await this.store.get<'code' | 'password'>('loginStep')) || 'code'
        : 'phone',
      loginExpiresAt: activeLogin ? expiresAt! : null,
    };
  }
  private async clearLogin() {
    await this.store.delete('login');
    await this.store.delete('loginStep');
    await this.store.delete('loginExpiresAt');
  }
  private async authorized(client: AdminClient) {
    const account = await client.me();
    if (account.id !== this.env.OWNER_TELEGRAM_ID) {
      await client.logout();
      await this.clearLogin();
      throw new HttpError(
        403,
        'Connect the Telegram account configured as Watchtower’s owner. The other account was signed out.',
      );
    }
    await this.seal('vault', { session: client.save(), account } satisfies Vault);
    await this.store.put('account', account);
    await this.clearLogin();
  }
  private async login() {
    const login = await this.open<Login>('login');
    if (!login || login.expiresAt <= Date.now()) {
      await this.clearLogin();
      throw new HttpError(409, 'Login expired. Request a new code.');
    }
    return login;
  }
  async jobs(chatId: string) {
    return [...(await this.store.list<HistoryCleanup>({ prefix: 'job:' })).values()]
      .filter((job) => job.chatId === chatId)
      .sort((a, b) => b.requestedAt - a.requestedAt)
      .slice(0, 100);
  }
  async queue(input: Pick<HistoryCleanup, 'chatId' | 'userId' | 'name' | 'throughMessageId'>) {
    if (!(await this.status()).connected)
      throw new HttpError(
        409,
        'Connect your Telegram admin account before deleting message history.',
      );
    const current = (await this.jobs(input.chatId)).find(
      (job) => job.userId === input.userId && ['queued', 'running'].includes(job.status),
    );
    if (current) return current;
    const now = Date.now();
    const job: HistoryCleanup = {
      ...input,
      id: crypto.randomUUID(),
      requestedAt: now,
      updatedAt: now,
      status: 'queued',
      attempts: 0,
      nextAt: now,
      error: '',
    };
    await this.store.put(`job:${job.id}`, job);
    await this.store.setAlarm(now + 1000);
    return job;
  }
  async handle(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/status' && request.method === 'GET') return json(await this.status());
      if (path === '/jobs' && request.method === 'GET') {
        const chatId = z
          .string()
          .regex(/^-100\d+$/)
          .parse(new URL(request.url).searchParams.get('chatId'));
        return json({ jobs: await this.jobs(chatId) });
      }
      if (request.method !== 'POST') throw new HttpError(404, 'Unknown admin action.');
      const body = await readJson(request, 8192);
      if (path === '/login/start') {
        if ((await this.status()).connected)
          throw new HttpError(409, 'Disconnect the current admin account first.');
        const { phone } = z.object({ phone: z.string().regex(/^\+[1-9]\d{6,14}$/) }).parse(body);
        const last = (await this.store.get<number>('lastLoginAt')) || 0;
        if (Date.now() - last < 60_000)
          throw new HttpError(429, 'Wait one minute before requesting another code.');
        await this.store.put('lastLoginAt', Date.now());
        await this.clearLogin();
        await this.client('', async (client) => {
          const hash = await client.sendCode(phone);
          const login: Login = {
            phone,
            hash,
            session: client.save(),
            step: 'code',
            expiresAt: Date.now() + 10 * 60_000,
          };
          await this.seal('login', login);
          await this.store.put('loginStep', 'code');
          await this.store.put('loginExpiresAt', login.expiresAt);
          await this.store.setAlarm(login.expiresAt);
        });
      } else if (path === '/login/code' || path === '/login/password') {
        const login = await this.login();
        const expected = path.endsWith('/code') ? 'code' : 'password';
        if (login.step !== expected)
          throw new HttpError(409, `Continue with the ${login.step} step.`);
        const { value } = z.object({ value: z.string().min(1).max(256) }).parse(body);
        await this.client(login.session, async (client) => {
          try {
            if (expected === 'code')
              await client.signIn(login.phone, login.hash, value.replace(/\s/g, ''));
            else await client.password(value);
            await this.authorized(client);
          } catch (e) {
            if (!adminFailure(e).needsPassword) throw e;
            await this.seal('login', { ...login, session: client.save(), step: 'password' });
            await this.store.put('loginStep', 'password');
          }
        });
      } else if (path === '/login/cancel') {
        await this.clearLogin();
      } else if (path === '/disconnect') {
        const vault = await this.open<Vault>('vault');
        if (vault) {
          try {
            await this.client(vault.session, (client) => client.logout());
          } catch (e) {
            if (!adminFailure(e).revoked) throw e;
          }
        }
        await this.store.delete('vault');
        await this.store.delete('account');
        await this.clearLogin();
        for (const job of (await this.store.list<HistoryCleanup>({ prefix: 'job:' })).values()) {
          if (['queued', 'running'].includes(job.status))
            await this.store.put(`job:${job.id}`, {
              ...job,
              status: 'failed',
              error: 'Admin account disconnected. Connect again and retry.',
              updatedAt: Date.now(),
            });
        }
        await this.store.deleteAlarm();
      } else if (path === '/queue') {
        const input = z
          .object({
            chatId: z.string().regex(/^-100\d+$/),
            userId: z.string().regex(/^[1-9]\d{0,15}$/),
            name: z.string().max(256),
            throughMessageId: z.number().int().min(0),
          })
          .parse(body);
        if (input.userId === this.env.OWNER_TELEGRAM_ID)
          throw new HttpError(403, 'The owner is protected.');
        await this.validateGroup(input.chatId, input.userId);
        return json(await this.queue(input), 202);
      } else throw new HttpError(404, 'Unknown admin action.');
      return json(await this.status());
    } catch (error) {
      if (error instanceof z.ZodError)
        return json({ error: 'Invalid Telegram admin request.' }, 400);
      const failure = adminFailure(error);
      if (!(error instanceof HttpError))
        console.warn('Telegram admin request failed', adminDiagnostic(error));
      if (failure.revoked) {
        await this.store.delete('vault');
        await this.store.delete('account');
      }
      const response = json(
        { error: failure.message },
        error instanceof HttpError ? error.status : failure.retryAfter ? 429 : 502,
      );
      if (failure.retryAfter) response.headers.set('Retry-After', String(failure.retryAfter));
      return response;
    }
  }
  async alarm() {
    const expiry = await this.store.get<number>('loginExpiresAt');
    if (expiry && expiry <= Date.now()) await this.clearLogin();
    const jobs = [...(await this.store.list<HistoryCleanup>({ prefix: 'job:' })).values()];
    const job = jobs
      .filter((j) => ['queued', 'running'].includes(j.status) && j.nextAt <= Date.now())
      .sort((a, b) => a.requestedAt - b.requestedAt)[0];
    if (job) {
      job.status = 'running';
      job.updatedAt = Date.now();
      job.nextAt = Date.now() + 60_000;
      await this.store.put(`job:${job.id}`, job);
      // Persist a wakeup before external work, so an eviction cannot strand the job.
      await this.store.setAlarm(job.nextAt);
      try {
        await this.validateGroup(job.chatId, job.userId);
        const vault = await this.open<Vault>('vault');
        if (!vault) throw new HttpError(409, 'Connect your Telegram admin account and retry.');
        const offset = await this.client(vault.session, async (client) => {
          if ((await client.me()).id !== this.env.OWNER_TELEGRAM_ID)
            throw new HttpError(403, 'The connected Telegram account is not the configured owner.');
          const offset = await client.deleteHistory(job.chatId, job.userId);
          await this.seal('vault', { ...vault, session: client.save() });
          return offset;
        });
        if (offset > 0) {
          job.status = 'queued';
          job.nextAt = Date.now() + 1000;
        } else {
          await this.complete(job);
          job.status = 'complete';
        }
        job.error = '';
      } catch (e) {
        const failure = adminFailure(e);
        job.attempts++;
        job.error = failure.message;
        if (failure.revoked) {
          await this.store.delete('vault');
          await this.store.delete('account');
        }
        const permanent = e instanceof HttpError && e.status < 500;
        job.status = permanent || failure.revoked || job.attempts >= 5 ? 'failed' : 'queued';
        job.nextAt =
          Date.now() + (failure.retryAfter || Math.min(900, 30 * 2 ** job.attempts)) * 1000;
      }
      job.updatedAt = Date.now();
      await this.store.put(`job:${job.id}`, job);
    }
    const pending = [
      ...(await this.store.list<HistoryCleanup>({ prefix: 'job:' })).values(),
    ].filter((j) => ['queued', 'running'].includes(j.status));
    const loginAt = await this.store.get<number>('loginExpiresAt');
    const wakeups = [...pending.map((j) => j.nextAt), ...(loginAt ? [loginAt] : [])];
    if (wakeups.length)
      await this.store.setAlarm(Math.max(Date.now() + 1000, Math.min(...wakeups)));
    else await this.store.deleteAlarm();
    // Keep a bounded status history; the group audit log retains confirmed actions.
    const terminal = [...(await this.store.list<HistoryCleanup>({ prefix: 'job:' })).values()]
      .filter((j) => ['complete', 'failed'].includes(j.status))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    for (const old of terminal.slice(100)) await this.store.delete(`job:${old.id}`);
  }
}

export function adminStub(env: Env) {
  if (!env.TELEGRAM_ADMIN) throw new HttpError(503, 'Telegram admin connection is not configured.');
  return env.TELEGRAM_ADMIN.get(env.TELEGRAM_ADMIN.idFromName('owner'));
}

export async function acknowledgeHistoryCleanup(db: Database, job: HistoryCleanup) {
  await db.transaction(async () => {
    await db.exec(
      'UPDATE messages SET deleted=1 WHERE user_id=? AND id<=? AND sent_at<=?',
      job.userId,
      job.throughMessageId,
      job.requestedAt,
    );
    const detail = `Telegram confirmed full message-history deletion for this user. Cleanup ${job.id}.`;
    await db.exec(
      "INSERT INTO audit (kind,user_id,detail,created_at) SELECT 'history_cleanup',?,?,? WHERE NOT EXISTS (SELECT 1 FROM audit WHERE kind='history_cleanup' AND detail=?)",
      job.userId,
      detail,
      Date.now(),
      detail,
    );
  });
}

export class TelegramAdmin {
  private service: TelegramAdminService;
  private execution: Promise<unknown> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: Env) {
    const dbFor = async (
      chatId: string,
      fn: (db: import('./database').PostgresDatabase) => Promise<void>,
    ) => {
      const { PostgresDatabase } = await import('./database');
      const db = new PostgresDatabase(env).forGroup(chatId);
      await db.session(() => fn(db));
    };
    this.service = new TelegramAdminService(
      ctx.storage,
      env,
      async (...args) => (await import('./telegram-admin-client')).createAdminClient(...args),
      async (job) => {
        await dbFor(job.chatId, (db) => acknowledgeHistoryCleanup(db, job));
      },
      async (chatId, userId) => {
        const { GroupDirectory } = await import('./directory');
        const { PostgresDatabase } = await import('./database');
        const { telegram } = await import('./telegram');
        const directory = new GroupDirectory(new PostgresDatabase(env), env);
        await directory.session(async () => {
          if ((await directory.get(chatId))?.status !== 'active')
            throw new HttpError(409, 'Reconnect this group before deleting history.');
        });
        await dbFor(chatId, async (db) => {
          const user = (
            await db.exec<{ strikes: number }>('SELECT strikes FROM users WHERE user_id=?', userId)
          )[0];
          if (!user?.strikes) throw new HttpError(409, 'This user no longer has strikes.');
          const config = (
            await db.exec<{ value: string }>('SELECT value FROM config WHERE id=1')
          )[0];
          if (
            userId === env.OWNER_TELEGRAM_ID ||
            JSON.parse(config.value).exemptUserIds?.includes(userId)
          )
            throw new HttpError(403, 'Owner and exempt users are protected.');
        });
        const member = await telegram<{ status: string }>(env, 'getChatMember', {
          chat_id: chatId,
          user_id: Number(userId),
        });
        if (['administrator', 'creator'].includes(member.status))
          throw new HttpError(403, 'Administrators and the group creator are protected.');
      },
    );
  }
  private serial<T>(fn: () => Promise<T>) {
    const result = this.execution.then(fn, fn);
    this.execution = result.catch(() => {});
    return result;
  }
  fetch(request: Request) {
    return this.serial(() => this.service.handle(request));
  }
  alarm() {
    return this.serial(() => this.service.alarm());
  }
}

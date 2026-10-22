import { AsyncLocalStorage } from 'node:async_hooks';
import pg, { type ClientConfig } from 'pg';
import type { Env } from './env';
import { HttpError } from './http';

export type SqlValue = string | number | null;
export class DatabaseUnavailableError extends HttpError {
  constructor() {
    super(
      503,
      'PostgreSQL is temporarily unavailable. Saved progress is retained; please retry shortly.',
    );
  }
}
export class LostWorkLeaseError extends HttpError {
  constructor() {
    super(503, 'Background work was interrupted. Saved progress will resume on the next tick.');
  }
}
const DATABASE_NOW = '(extract(epoch from clock_timestamp())*1000)::bigint';
const WORK_LEASE_MS = 120_000;
function databaseError(error: unknown): never {
  if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
    throw new HttpError(
      409,
      'A record with this ID already exists. Message IDs must be unique within a dataset.',
    );
  // Connection strings and server diagnostics must not reach the browser or audit log.
  throw new DatabaseUnavailableError();
}
export interface Database {
  readonly kind: 'sqlite' | 'postgres';
  exec<T = Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): Promise<T[]>;
  transaction<T>(callback: () => Promise<T>): Promise<T>;
  session<T>(callback: () => Promise<T>): Promise<T>;
}
export class SqliteDatabase implements Database {
  readonly kind = 'sqlite';
  constructor(private ctx: DurableObjectState) {}
  async exec<T>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    // Consume synchronously: a cursor held across await is not a stable snapshot.
    return this.ctx.storage.sql.exec(sql, ...params).toArray() as T[];
  }
  transaction<T>(callback: () => Promise<T>) {
    return this.ctx.storage.transaction(callback);
  }
  session<T>(callback: () => Promise<T>) {
    return callback();
  }
}

export function databaseSchema(chatId: string) {
  if (!/^-100\d+$/.test(chatId)) throw new HttpError(503, 'Configure the supergroup ID.');
  return `watchtower_g${chatId.slice(1)}`;
}
export const STORAGE_TABLES = [
  'config',
  'updates',
  'users',
  'messages',
  'audit',
  'actions',
  'usage',
  'datasets',
  'dataset_stats',
  'examples',
  'dataset_imports',
  'dataset_import_chunks',
  'evaluations',
  'run_examples',
  'predictions',
  'evaluation_labels',
  'feedback_events',
  'policy_drafts',
  'policy_versions',
  'improvement_test_families',
  'policy_reference_sets',
  'policy_evidence_consumption',
  'improvement_test_inputs',
] as const;
const QUERY_TABLES = [...STORAGE_TABLES, 'storage_state', 'work_state'];

// Keep the existing SQL vocabulary consistent between the local SQLite and Postgres backends.
// Values always remain bound parameters, including imported untrusted Telegram text.
export function postgresSql(source: string): string {
  let sql = source
    .replace(
      /strftime\('%Y-%m-%d',sent_at\/1000,'unixepoch'\)/g,
      "to_char(to_timestamp(sent_at/1000.0) AT TIME ZONE 'UTC','YYYY-MM-DD')",
    )
    .replace(/\binstr\(/gi, 'strpos(')
    .replace(/\bMAX\(([^(),]+),([^()]+)\)/gi, 'GREATEST($1,$2)')
    .replace(/\bMIN\(([^(),]+),([^()]+)\)/gi, 'LEAST($1,$2)')
    .replace(
      'lab_tokens=lab_tokens+excluded.lab_tokens',
      'lab_tokens=usage.lab_tokens+excluded.lab_tokens',
    );
  if (/^\s*INSERT OR IGNORE\b/i.test(sql))
    sql =
      sql.replace('INSERT OR IGNORE', 'INSERT').replace(/;\s*$/, '') + ' ON CONFLICT DO NOTHING';
  if (/^\s*INSERT OR REPLACE INTO predictions\b/i.test(sql))
    sql =
      sql.replace('INSERT OR REPLACE', 'INSERT') +
      ' ON CONFLICT(run_id,id) DO UPDATE SET score=excluded.score,category=excluded.category,reason=excluded.reason' +
      (source.includes('needs_review') ? ',needs_review=excluded.needs_review' : '');
  let result = '',
    index = 0,
    quote = false;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (char === "'") {
      if (quote && sql[i + 1] === "'") {
        result += "''";
        i++;
        continue;
      }
      quote = !quote;
    }
    result += char === '?' && !quote ? `$${++index}` : char;
  }
  // Nullable model cost is otherwise an untyped parameter in Postgres.
  return result.replace(/(\$\d+) IS NULL/g, '$1::double precision IS NULL');
}

export interface PostgresTransport {
  sslMode?: 'verify-full' | 'disable';
  sslCa?: string;
}
export function postgresConfig(
  connection: string,
  dev = false,
  hyperdrive = false,
  options: PostgresTransport = {},
): ClientConfig {
  let url: URL;
  try {
    url = new URL(connection);
  } catch {
    throw new HttpError(503, 'Invalid PostgreSQL connection configuration.');
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    url.hash ||
    (local && !dev && !hyperdrive && options.sslMode !== 'disable')
  )
    throw new HttpError(
      503,
      'Use a PostgreSQL connection. Loopback connections require development mode or explicit DATABASE_SSL_MODE=disable.',
    );
  if (options.sslMode && !['verify-full', 'disable'].includes(options.sslMode))
    throw new HttpError(503, 'DATABASE_SSL_MODE must be verify-full or disable.');
  if (options.sslCa && (options.sslMode === 'disable' || hyperdrive))
    throw new HttpError(503, 'Configure the CA on the TLS connection, not a plaintext connection.');
  // pg uses cloudflare:sockets in Workers; its TLS upgrade cannot install a CA.
  // Reject this explicitly instead of silently ignoring a configured trust root.
  if (options.sslCa && globalThis.navigator?.userAgent === 'Cloudflare-Workers')
    throw new HttpError(
      503,
      'Direct Cloudflare PostgreSQL requires a publicly trusted certificate. Configure custom CA trust on Hyperdrive, or use the Node runtime.',
    );
  // Do not let URL options silently disable TLS or replace the verified SSL configuration.
  for (const key of ['ssl', 'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'sslnegotiation'])
    url.searchParams.delete(key);
  return {
    connectionString: url.href,
    // The trusted binding handles origin TLS; direct connections still verify certificates.
    ssl:
      hyperdrive || options.sslMode === 'disable' || (local && dev && !options.sslMode)
        ? false
        : { rejectUnauthorized: true, ...(options.sslCa ? { ca: options.sslCa } : {}) },
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    application_name: 'unspammed',
    types: {
      getTypeParser(oid, format) {
        if (format !== 'binary' && [20, 1700].includes(oid))
          return (value: string) => {
            const number = Number(value);
            if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER)
              throw new Error('Database number exceeds safe application precision.');
            return number;
          };
        return pg.types.getTypeParser(oid, format as any);
      },
    },
  };
}

export type DatabaseEnvironment = Pick<
  Env,
  | 'DATABASE_URL'
  | 'PLANETSCALE_DATABASE_URL'
  | 'DATABASE_SSL_MODE'
  | 'DATABASE_SSL_CA'
  | 'HYPERDRIVE'
  | 'DEV_MODE'
  | 'TELEGRAM_CHAT_ID'
  | 'DATABASE_ROOT_CHAT_ID'
>;

export function postgresEnvironmentConfig(env: DatabaseEnvironment): ClientConfig {
  const connection =
    env.HYPERDRIVE?.connectionString || env.DATABASE_URL || env.PLANETSCALE_DATABASE_URL;
  if (!connection) throw new HttpError(503, 'Configure DATABASE_URL.');
  return postgresConfig(connection, env.DEV_MODE === 'true', !!env.HYPERDRIVE, {
    sslMode: env.DATABASE_SSL_MODE,
    sslCa: env.DATABASE_SSL_CA,
  });
}

interface Session {
  client?: Promise<pg.Client>;
  transaction: boolean;
  lease?: string;
}
export class PostgresDatabase implements Database {
  readonly kind = 'postgres';
  private sessions = new AsyncLocalStorage<Session>();
  readonly schema: string;
  private config: ClientConfig;
  readonly tablePrefix: string;
  private environment: DatabaseEnvironment;
  constructor(env: DatabaseEnvironment, sessions?: AsyncLocalStorage<Session>) {
    this.config = postgresEnvironmentConfig(env);
    this.environment = env;
    const root = env.DATABASE_ROOT_CHAT_ID || env.TELEGRAM_CHAT_ID;
    this.schema = databaseSchema(root);
    databaseSchema(env.TELEGRAM_CHAT_ID);
    this.tablePrefix = env.TELEGRAM_CHAT_ID === root ? '' : `g${env.TELEGRAM_CHAT_ID.slice(1)}_`;
    if (sessions) this.sessions = sessions;
  }
  forGroup(chatId: string) {
    if (chatId === this.environment.TELEGRAM_CHAT_ID) return this;
    return new PostgresDatabase(
      {
        ...this.environment,
        DATABASE_ROOT_CHAT_ID:
          this.environment.DATABASE_ROOT_CHAT_ID || this.environment.TELEGRAM_CHAT_ID,
        TELEGRAM_CHAT_ID: chatId,
      },
      this.sessions,
    );
  }
  table(name: string) {
    if (![...QUERY_TABLES, 'watchtower_groups'].includes(name as any))
      throw new Error('Unknown application table.');
    return `"${this.schema}"."${name === 'watchtower_groups' ? '' : this.tablePrefix}${name}"`;
  }
  async session<T>(callback: () => Promise<T>): Promise<T> {
    if (this.sessions.getStore()) return callback();
    const session: Session = { transaction: false };
    return this.sessions.run(session, async () => {
      try {
        return await callback();
      } finally {
        if (session.client) await (await session.client.catch(() => null))?.end().catch(() => {});
      }
    });
  }
  private async client() {
    const session = this.sessions.getStore();
    if (!session) throw new Error('Database operations require a request session.');
    session.client ||= (async () => {
      const client = new pg.Client(this.config);
      client.on('error', () => {});
      try {
        await client.connect();
        return client;
      } catch (e) {
        await client.end().catch(() => {});
        databaseError(e);
      }
    })();
    return session.client;
  }
  async exec<T>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    if (!this.sessions.getStore()) return this.session(() => this.exec(sql, ...params));
    const session = this.sessions.getStore()!;
    // Every background write is fenced against a replaced/expired worker, including
    // writes outside the explicit strike/cursor transactions. HTTP requests are independent.
    if (session.lease && !session.transaction && /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))
      return this.transaction(() => this.exec(sql, ...params));
    // Explicit qualification also works outside a transaction with transaction-mode pooling.
    const query = postgresSql(sql).replace(
      new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+(${QUERY_TABLES.join('|')})\\b`, 'gi'),
      (_, keyword, table) =>
        `${keyword} ${this.table(table)}${this.tablePrefix && keyword.toUpperCase() === 'INTO' ? ` AS ${table}` : ''}`,
    );
    try {
      const result = await (await this.client()).query(query, params);
      return result.rows as T[];
    } catch (e) {
      if (e instanceof HttpError) throw e;
      databaseError(e);
    }
  }
  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    if (!this.sessions.getStore()) return this.session(() => this.transaction(callback));
    const session = this.sessions.getStore()!;
    if (session.transaction) return callback();
    const client = await this.client();
    try {
      await client.query('BEGIN');
    } catch (e) {
      databaseError(e);
    }
    try {
      await client.query(`SET LOCAL search_path TO "${this.schema}"`);
      // Protect read-modify-write state across overlapping requests and actor replacements.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        this.schema + this.tablePrefix,
      ]);
      if (session.lease) {
        const renewed = await client.query(
          `UPDATE ${this.table('work_state')} SET expires_at=${DATABASE_NOW}+$2
           WHERE id=1 AND owner=$1 AND expires_at>${DATABASE_NOW} RETURNING id`,
          [session.lease, WORK_LEASE_MS],
        );
        if (!renewed.rows.length) throw new LostWorkLeaseError();
      }
      session.transaction = true;
      const result = await callback();
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (e instanceof Error && ('severity' in e || 'code' in e)) databaseError(e);
      throw e;
    } finally {
      session.transaction = false;
    }
  }
  async assertWorkLease() {
    if (this.sessions.getStore()?.lease) await this.transaction(async () => {});
  }
  async withWorkLease(callback: () => Promise<void>): Promise<boolean> {
    return this.session(async () => {
      const session = this.sessions.getStore()!;
      const owner = crypto.randomUUID();
      const claimed = await this.transaction(() =>
        this.exec(
          `UPDATE work_state SET owner=?,expires_at=${DATABASE_NOW}+?
         WHERE id=1 AND expires_at<=${DATABASE_NOW} RETURNING id`,
          owner,
          WORK_LEASE_MS,
        ),
      );
      if (!claimed.length) return false;
      session.lease = owner;
      try {
        await callback();
        return true;
      } finally {
        session.lease = undefined;
        // A stale worker must never release its replacement's lease.
        await this.exec(
          `UPDATE work_state SET owner='',expires_at=0,last_run_at=${DATABASE_NOW} WHERE id=1 AND owner=?`,
          owner,
        );
      }
    });
  }
}

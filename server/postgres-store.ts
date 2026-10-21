import pg, { type ClientConfig } from 'pg';
import { databaseSchema, postgresEnvironmentConfig } from '../worker/database';
import type { Env } from '../worker/env';
import { HttpError } from '../worker/http';
import type { AdminStore } from '../worker/telegram-admin';

export type RuntimeStore = AdminStore;
const DATABASE_NOW = '(EXTRACT(EPOCH FROM clock_timestamp())*1000)::bigint';
const LEASE_MS = 60_000;

// Runtime leases and every state write commit before network work. Short row-locked
// transactions support direct PostgreSQL and transaction poolers without pinning an
// idle transaction while a provider or Telegram operation is in flight.
export class PostgresRuntimeStore {
  private config: ClientConfig;
  private schema: string;
  private table: string;
  private leases: string;
  constructor(env: Env) {
    this.config = postgresEnvironmentConfig(env);
    this.schema = databaseSchema(env.DATABASE_ROOT_CHAT_ID || env.TELEGRAM_CHAT_ID);
    this.table = `"${this.schema}"."watchtower_runtime"`;
    this.leases = `"${this.schema}"."watchtower_runtime_leases"`;
  }
  private async connect() {
    const client = new pg.Client(this.config);
    client.on('error', () => {});
    try {
      await client.connect();
      return client;
    } catch {
      await client.end().catch(() => {});
      throw new HttpError(503, 'Background storage is temporarily unavailable. Please retry.');
    }
  }
  async run<T>(
    namespace: string,
    callback: (store: RuntimeStore) => Promise<T>,
  ): Promise<{ acquired: false } | { acquired: true; value: T }> {
    const client = await this.connect();
    const owner = crypto.randomUUID();
    let acquired = false;
    let healthy = true;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let execution: Promise<unknown> = Promise.resolve();
    const replaced = () => new HttpError(503, 'Background storage operation was replaced. Retry.');
    const serial = <V>(operation: () => Promise<V>) => {
      const result = execution.then(operation);
      execution = result.catch(() => {});
      return result;
    };
    const transaction = async <V>(operation: () => Promise<V>) => {
      await client.query('BEGIN');
      try {
        const result = await operation();
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    };
    // The conditional renewal also locks this lease row until the accompanying
    // state mutation commits. A replacement cannot claim it between check/write.
    const fenced = <V>(operation: () => Promise<V>) =>
      serial(async () => {
        if (!healthy) throw replaced();
        return transaction(async () => {
          const renewed = await client.query(
            `UPDATE ${this.leases} SET expires_at=${DATABASE_NOW}+$3
             WHERE namespace=$1 AND owner=$2 AND expires_at>${DATABASE_NOW} RETURNING namespace`,
            [namespace, owner, LEASE_MS],
          );
          if (!renewed.rows.length) {
            healthy = false;
            throw replaced();
          }
          return operation();
        });
      });
    try {
      await transaction(async () => {
        // Serialize only first-use DDL; no external calls run inside this lock.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `${this.schema}/runtime/ddl`,
        ]);
        await client.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
          namespace TEXT NOT NULL, key TEXT NOT NULL, value JSONB NOT NULL,
          PRIMARY KEY(namespace,key)
        )`);
        await client.query(`CREATE TABLE IF NOT EXISTS ${this.leases} (
          namespace TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at BIGINT NOT NULL
        )`);
      });
      const claimed = await client.query(
        `INSERT INTO ${this.leases}(namespace,owner,expires_at) VALUES($1,$2,${DATABASE_NOW}+$3)
         ON CONFLICT(namespace) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
         WHERE ${this.leases}.expires_at<=${DATABASE_NOW} RETURNING namespace`,
        [namespace, owner, LEASE_MS],
      );
      if (!claimed.rows.length) return { acquired: false };
      acquired = true;
      client.on('error', () => {
        healthy = false;
      });
      heartbeat = setInterval(() => {
        void fenced(async () => {}).catch(() => {
          healthy = false;
        });
      }, 10_000);
      heartbeat.unref();
      const query = (sql: string, values: unknown[]) => fenced(() => client.query(sql, values));
      const store: RuntimeStore = {
        get: async <V>(key: string) => {
          const result = await query(
            `SELECT value FROM ${this.table} WHERE namespace=$1 AND key=$2`,
            [namespace, key],
          );
          return result.rows[0]?.value as V | undefined;
        },
        put: async (key, value) =>
          query(
            `INSERT INTO ${this.table}(namespace,key,value) VALUES($1,$2,$3::jsonb)
             ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value`,
            [namespace, key, JSON.stringify(value)],
          ),
        delete: async (key) =>
          query(`DELETE FROM ${this.table} WHERE namespace=$1 AND key=$2`, [namespace, key]),
        list: async <V>({ prefix }: { prefix: string }) => {
          const result = await query(
            `SELECT key,value FROM ${this.table} WHERE namespace=$1 AND left(key,length($2))=$2`,
            [namespace, prefix],
          );
          return new Map(result.rows.map((row) => [row.key, row.value as V]));
        },
        setAlarm: async (time) => store.put('$alarm', time),
        deleteAlarm: async () => store.delete('$alarm'),
      };
      const value = await callback(store);
      await fenced(async () => {});
      return { acquired: true, value };
    } finally {
      clearInterval(heartbeat);
      await execution;
      if (acquired)
        await client
          .query(
            `UPDATE ${this.leases} SET owner='',expires_at=0 WHERE namespace=$1 AND owner=$2`,
            [namespace, owner],
          )
          .catch(() => {});
      await client.end().catch(() => {});
    }
  }
}

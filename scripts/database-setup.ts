import { initializePostgres, discardLegacyHistory } from '../worker/storage';
import { PostgresDatabase, type DatabaseEnvironment } from '../worker/database';
import { initializeDirectory, provision } from '../worker/directory';
import { defaultSettings } from '../shared/types';
import { canonicalEnvironment, loadEnvironment } from './setup-env.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function databaseSetupEnvironment(
  source: Record<string, string | undefined> = process.env,
): DatabaseEnvironment {
  const configured = canonicalEnvironment(source);
  const chatId = configured.DATABASE_ROOT_CHAT_ID || configured.TELEGRAM_CHAT_ID;
  if (!chatId || !/^-100\d+$/.test(chatId))
    throw new Error('Configure TELEGRAM_CHAT_ID with your numeric supergroup ID.');
  const url = configured.DATABASE_ADMIN_URL || configured.DATABASE_URL;
  if (!url) throw new Error('Configure DATABASE_URL before database setup.');
  // A provider's setup endpoint must be supplied explicitly; never infer its
  // transport or replace a caller-selected port from the database hostname.
  return {
    DATABASE_URL: url,
    DATABASE_SSL_MODE: configured.DATABASE_SSL_MODE as DatabaseEnvironment['DATABASE_SSL_MODE'],
    DATABASE_SSL_CA: configured.DATABASE_SSL_CA,
    TELEGRAM_CHAT_ID: chatId,
    DEV_MODE: configured.DEV_MODE || 'false',
  };
}

export async function main() {
  loadEnvironment();
  const environment = databaseSetupEnvironment();
  const chatId = environment.TELEGRAM_CHAT_ID;
  await initializePostgres(environment, true);
  const db = new PostgresDatabase(environment);
  if (process.argv.includes('--discard-legacy-history')) await discardLegacyHistory(db);
  await initializeDirectory(db, { TELEGRAM_CHAT_ID: chatId });
  await db.transaction(async () => {
    const groups = await db.exec<{ chat_id: string }>(
      `SELECT chat_id FROM ${db.table('watchtower_groups')} WHERE provisioned=1`,
    );
    for (const group of groups) await provision(db.forGroup(group.chat_id), defaultSettings);
  });
  console.log('PostgreSQL schema is ready. Existing application data was preserved.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === '42501') {
      console.error(
        'The database role needs schema/table creation privileges. Use DATABASE_ADMIN_URL for setup if required, then grant the runtime role access to the application schema. Never deploy the administrator connection.',
      );
    } else {
      console.error(
        'Database setup failed. Check TELEGRAM_CHAT_ID, DATABASE_URL, TLS settings, and schema privileges. No connection credentials were printed.',
      );
    }
    process.exitCode = 1;
  });
}

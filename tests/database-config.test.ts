import { describe, expect, it } from 'vitest';
import { postgresConfig, postgresEnvironmentConfig } from '../worker/database';

describe('database connection transport', () => {
  it('keeps TLS verification mandatory for direct production connections', () => {
    const config = postgresConfig('postgresql://user:password@test.psdb.cloud/db?sslmode=disable');
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
    expect(config.connectionString).not.toContain('sslmode');
    expect(() => postgresConfig('postgresql://user:password@localhost/db')).toThrow();
    expect(postgresConfig('postgresql://user:password@db.example/db').ssl).toEqual({
      rejectUnauthorized: true,
    });
    expect(() => postgresConfig('https://db.example/db')).toThrow();
  });
  it('lets the trusted Hyperdrive binding handle origin TLS and preserves numeric parsing', () => {
    const config = postgresConfig('postgresql://user:password@hyperdrive.internal/db', false, true);
    expect(config.ssl).toBe(false);
    expect(config.types!.getTypeParser(20, 'text')('42')).toBe(42);
    expect(() => config.types!.getTypeParser(20, 'text')('9007199254740992')).toThrow();
  });
  it('supports explicit private networking and rejects unavailable Workers CA overrides', () => {
    expect(
      postgresConfig('postgresql://u:p@postgres.railway.internal/db', false, false, {
        sslMode: 'disable',
      }).ssl,
    ).toBe(false);
    expect(() =>
      postgresConfig('postgresql://u:p@db.example/db?sslmode=no-verify&ssl=false', false, false, {
        sslMode: 'verify-full',
        sslCa: 'trusted-ca',
      }),
    ).toThrow('publicly trusted certificate');
    expect(() =>
      postgresConfig('postgres://localhost/db', false, false, {
        sslMode: 'disable',
        sslCa: 'unused-ca',
      }),
    ).toThrow();
    expect(() =>
      postgresConfig('postgres://db.example/db', false, false, {
        sslMode: 'require' as any,
      }),
    ).toThrow();
    expect(postgresConfig('postgres://localhost/db', true).ssl).toBe(false);
  });
  it('prefers canonical environment names and preserves old deployment aliases', () => {
    const legacy = {
      DEV_MODE: 'false',
      TELEGRAM_CHAT_ID: '-1001234567890',
      PLANETSCALE_DATABASE_URL: 'postgres://legacy:secret@old.psdb.cloud/db',
    };
    expect(postgresEnvironmentConfig(legacy).connectionString).toContain('old.psdb.cloud');
    expect(
      postgresEnvironmentConfig({
        ...legacy,
        DATABASE_URL: 'postgres://user:secret@new.example/db',
      }).connectionString,
    ).toContain('new.example');
    expect(
      postgresEnvironmentConfig({
        ...legacy,
        HYPERDRIVE: {
          connectionString: 'postgres://user:secret@hyperdrive.internal/db',
        } as Hyperdrive,
      }).ssl,
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { postgresConfig } from '../worker/database';

describe('database connection transport', () => {
  it('keeps TLS verification mandatory for direct production connections', () => {
    const config = postgresConfig('postgresql://user:password@test.psdb.cloud/db?sslmode=disable');
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
    expect(config.connectionString).not.toContain('sslmode');
    expect(() => postgresConfig('postgresql://user:password@localhost/db')).toThrow();
    expect(() => postgresConfig('postgresql://user:password@untrusted.example/db')).toThrow();
  });
  it('lets the trusted Hyperdrive binding handle origin TLS and preserves numeric parsing', () => {
    const config = postgresConfig('postgresql://user:password@hyperdrive.internal/db', false, true);
    expect(config.ssl).toBe(false);
    expect(config.types!.getTypeParser(20, 'text')('42')).toBe(42);
    expect(() => config.types!.getTypeParser(20, 'text')('9007199254740992')).toThrow();
  });
});

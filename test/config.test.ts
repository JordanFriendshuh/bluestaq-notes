import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@db:5432/notes',
  JWT_SECRET: 'x'.repeat(32),
};
const productionWithTls = {
  ...base,
  NODE_ENV: 'production',
  TLS_CERT_FILE: '/secrets/api.crt',
  TLS_KEY_FILE: '/secrets/api.key',
};

describe('parseConfig', () => {
  it('defaults to verified TLS for the database', () => {
    expect(parseConfig(base).DATABASE_TLS).toBe('verify');
  });

  it('accepts production with HTTPS and database TLS', () => {
    expect(() => parseConfig(productionWithTls)).not.toThrow();
  });

  it('refuses database TLS off in production', () => {
    expect(() => parseConfig({ ...productionWithTls, DATABASE_TLS: 'off' })).toThrow(
      /DATABASE_TLS=off/,
    );
  });

  it('refuses plain HTTP in production unless TLS ends at a proxy', () => {
    const plainHttp = { ...base, NODE_ENV: 'production' };

    expect(() => parseConfig(plainHttp)).toThrow(/TLS_TERMINATED_UPSTREAM/);
    expect(() => parseConfig({ ...plainHttp, TLS_TERMINATED_UPSTREAM: 'true' })).not.toThrow();
  });

  it('requires the certificate and key together', () => {
    expect(() => parseConfig({ ...base, TLS_CERT_FILE: '/secrets/api.crt' })).toThrow(
      /must be set together/,
    );
  });

  it('reads the JWT secret from JWT_SECRET_FILE', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'notes-')), 'jwt.secret');
    writeFileSync(file, `${'s'.repeat(64)}\n`);

    expect(parseConfig({ DATABASE_URL: base.DATABASE_URL, JWT_SECRET_FILE: file }).JWT_SECRET).toBe(
      's'.repeat(64),
    );
  });

  it('rejects a short JWT secret from a file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'notes-')), 'jwt.secret');
    writeFileSync(file, 'short');

    expect(() => parseConfig({ DATABASE_URL: base.DATABASE_URL, JWT_SECRET_FILE: file })).toThrow(
      /at least 32/,
    );
  });
});

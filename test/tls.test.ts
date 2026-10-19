import { readFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../src/http/create-server.js';
import { createTestApp } from './helpers/app.js';
import { TEST_DATABASE_URL } from './helpers/db.js';

const { app, db } = createTestApp();
const server = createServer(app, { certFile: 'secrets/api.crt', keyFile: 'secrets/api.key' });
const ca = readFileSync('secrets/ca.crt');
let port: number;

beforeAll(() => new Promise<void>((resolve) => server.listen(0, resolve)));
beforeAll(() => {
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.close();
  await db.destroy();
});

function httpsGet(path: string, options: https.RequestOptions) {
  return new Promise<number>((resolve, reject) => {
    https
      .get({ host: 'localhost', port, path, ...options }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on('error', reject);
  });
}

describe('API over HTTPS', () => {
  it('serves requests to clients that trust the local CA', async () => {
    expect(await httpsGet('/health', { ca })).toBe(200);
  });

  it('fails the handshake for clients that do not trust the certificate', async () => {
    await expect(httpsGet('/health', {})).rejects.toThrow(/self-signed|unable to verify/i);
  });
});

describe('database transport', () => {
  it('rejects connections that do not use TLS', async () => {
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL, ssl: false });

    await expect(client.connect()).rejects.toThrow(/no encryption|pg_hba/);
  });
});

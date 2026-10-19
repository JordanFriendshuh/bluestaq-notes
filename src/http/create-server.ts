import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { Express } from 'express';

export interface ServerTls {
  certFile: string;
  keyFile: string;
}

/** Serves the app over HTTPS when a certificate is given, otherwise plain HTTP. */
export function createServer(app: Express, tls?: ServerTls): http.Server {
  if (!tls) return http.createServer(app);
  return https.createServer(
    { cert: readFileSync(tls.certFile), key: readFileSync(tls.keyFile), minVersion: 'TLSv1.2' },
    app,
  );
}

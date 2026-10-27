import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { attachPresence } from '../../src/presence/socket.js';
import { createTestApp } from './app.js';

/** The app plus /ws on a real server on a random local port; call close() in afterAll. */
export async function startPresenceServer(options: { heartbeatMs?: number } = {}) {
  const ctx = createTestApp();
  const server = http.createServer(ctx.app);
  const presence = attachPresence(server, {
    db: ctx.db,
    auth: ctx.auth,
    events: ctx.events,
    authTimeoutMs: 200,
    ...options,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    ...ctx,
    url: `ws://127.0.0.1:${port}/ws`,
    async close() {
      await presence.close();
      await new Promise((resolve) => server.close(resolve));
      await ctx.db.destroy();
    },
  };
}

export interface Message {
  type: string;
  [key: string]: unknown;
}

/** A WebSocket client that buffers messages so tests can wait for the one they expect. */
export class TestClient {
  private readonly received: Message[] = [];
  private waiters: { match: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];
  readonly closed: Promise<number>;

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as Message;
      const waiter = this.waiters.find((w) => w.match(message));
      if (waiter) {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        waiter.resolve(message);
      } else {
        this.received.push(message);
      }
    });
    this.closed = new Promise((resolve) => socket.on('close', (code) => resolve(code)));
  }

  static async open(url: string, options: WebSocket.ClientOptions = {}): Promise<TestClient> {
    const socket = new WebSocket(url, options);
    const client = new TestClient(socket);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return client;
  }

  /** Opens a connection and authenticates it with the token. */
  static async signedIn(url: string, token: string, options?: WebSocket.ClientOptions) {
    const client = await TestClient.open(url, options);
    client.send({ type: 'auth', token });
    await client.next('ready');
    return client;
  }

  send(message: object | string): void {
    this.socket.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  /** The first message of this type (and matching `where`), already received or still to come. */
  next(
    type: string,
    where: (m: Message) => boolean = () => true,
    timeoutMs = 2000,
  ): Promise<Message> {
    const match = (m: Message) => m.type === type && where(m);
    const index = this.received.findIndex(match);
    if (index >= 0) return Promise.resolve(this.received.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No ${type} message within ${timeoutMs}ms`)),
        timeoutMs,
      );
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  /** Forgets buffered messages, so later waits only see what arrives from now on. */
  drain(): void {
    this.received.length = 0;
  }

  /** Every message received so far that nobody waited for. */
  unread(): Message[] {
    return [...this.received];
  }

  close(): void {
    this.socket.close();
  }
}

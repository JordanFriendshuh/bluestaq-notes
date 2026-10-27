/** Abuse limits for /ws; each one closes or refuses before a client can hurt the process or other users. */
export const WS_LIMITS = {
  /** Largest message accepted; anything bigger closes the connection with 1009. */
  maxMessageBytes: 16 * 1024,
  /** Messages per second per connection before it's closed with 1008. */
  messagesPerSecond: 30,
  /** Messages waiting on the database per connection before it's closed with 1008. */
  maxPendingMessages: 20,
  /** Rooms one connection can be in at once. */
  maxRoomsPerConnection: 50,
  /** Open, signed-in connections per user; the next one is closed with 4429. */
  maxConnectionsPerUser: 20,
  /** Bytes queued to a client that isn't reading before it's dropped. */
  maxBufferedBytes: 1024 * 1024,
};

/** Counts messages in fixed one-second windows. */
export class MessageRate {
  private windowStart = 0;
  private count = 0;

  constructor(private readonly perSecond: number) {}

  /** Records one message; false once the connection is over its rate for this second. */
  allow(now = Date.now()): boolean {
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.count = 0;
    }
    this.count += 1;
    return this.count <= this.perSecond;
  }
}

import type {
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  RootOperationNode,
  UnknownRow,
} from 'kysely';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { PresenceHub } from '../../src/presence/hub.js';
import { WS_LIMITS } from '../../src/presence/limits.js';
import { registerTestUser, resetDb } from '../helpers/app.js';
import { startPresenceServer, TestClient } from '../helpers/presence.js';

describe('access-change rechecks are scoped', () => {
  it('a team change only touches the users it names, not every room on the server', () => {
    const hub = new PresenceHub(WS_LIMITS.maxBufferedBytes);
    const socket = () =>
      ({
        OPEN: 1,
        readyState: 1,
        bufferedAmount: 0,
        send() {},
        terminate() {},
      }) as unknown as WebSocket;
    const member = (userId: string) => ({
      userId,
      displayName: userId,
      role: 'viewer' as const,
      mode: 'viewing' as const,
    });
    hub.join('note-1', socket(), member('alice'));
    hub.join('note-2', socket(), member('alice'));
    hub.join('note-1', socket(), member('bob'));
    hub.join('note-3', socket(), member('carol'));

    const affected = hub.affectedBy({ type: 'access.changed', userIds: ['alice'] });

    expect(affected.map((m) => [m.noteId, m.member.userId]).sort()).toEqual([
      ['note-1', 'alice'],
      ['note-2', 'alice'],
    ]);
    expect(hub.affectedBy({ type: 'access.changed', noteId: 'note-1' })).toHaveLength(2);
  });
});

describe('revocation racing a join', () => {
  it('re-checks a join whose access lookup overlapped a revocation', async () => {
    let delayMs = 0;
    const slow = await startPresenceServer({
      presenceDb: (base) => base.withPlugin(new DelayResults(() => delayMs)),
    });
    try {
      await resetDb(slow.db);
      const owner = await registerTestUser(slow.app, 'owner');
      const guest = await registerTestUser(slow.app, 'guest');
      const auth = `Bearer ${owner.token}`;
      const noteId = (
        await request(slow.app).post('/notes').set('Authorization', auth).send({ title: 'n' })
      ).body.note.id;
      const share = (
        await request(slow.app)
          .put(`/notes/${noteId}/shares`)
          .set('Authorization', auth)
          .send({ userEmail: guest.user.email, role: 'viewer' })
      ).body.share;
      const client = await TestClient.signedIn(slow.url, guest.token);

      // The join's lookup runs now but its answer ("viewer") arrives 300 ms late; the share is
      // deleted in between, so the answer is stale by the time it lands.
      delayMs = 300;
      client.send({ type: 'join', noteId });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await request(slow.app)
        .delete(`/notes/${noteId}/shares/${share.id}`)
        .set('Authorization', auth)
        .expect(204);

      expect(await client.next('error')).toMatchObject({ code: 'not_found' });
      client.close();
    } finally {
      await slow.close();
    }
  });
});

/** A Kysely plugin that holds every query result back by a configurable delay. */
class DelayResults implements KyselyPlugin {
  constructor(private readonly delayMs: () => number) {}

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return args.node;
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    const ms = this.delayMs();
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    return args.result;
  }
}

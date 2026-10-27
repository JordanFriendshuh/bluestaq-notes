import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, registerTestUser, resetDb } from '../helpers/app.js';

const { app, db } = createTestApp();

beforeEach(() => resetDb(db));
afterAll(() => db.destroy());

const rpc = (token: string | null, body: object, headers: Record<string, string> = {}) => {
  const req = request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set(headers);
  return (token ? req.set('Authorization', `Bearer ${token}`) : req).send(body);
};

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 't', version: '0' },
  },
};
const callTool = (name: string, args: object) => ({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name, arguments: args },
});

describe('MCP transport', () => {
  it('issues no session id, so there is no session to steal', async () => {
    const user = await registerTestUser(app, 'user');
    const res = await rpc(user.token, initialize);

    expect(res.status).toBe(200);
    expect(res.headers['mcp-session-id']).toBeUndefined();
  });

  it.each([
    ['no token', null],
    ['a garbage token', 'not-a-jwt'],
  ])('refuses a request with %s', async (_label, token) => {
    expect((await rpc(token, initialize)).status).toBe(401);
  });

  it('acts only as the token’s user, whatever session header is sent', async () => {
    const alice = await registerTestUser(app, 'alice');
    const mallory = await registerTestUser(app, 'mallory');
    const note = await request(app)
      .post('/notes')
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Private' });

    const res = await rpc(mallory.token, callTool('get_note', { noteId: note.body.note.id }), {
      'Mcp-Session-Id': 'alice-session',
    });

    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toContain('not_found');
    expect(JSON.stringify(res.body)).not.toContain('Private');
  });

  it('refuses bodies over the API limit', async () => {
    const user = await registerTestUser(app, 'user');
    const res = await rpc(
      user.token,
      callTool('create_note', { title: 'x', body: 'y'.repeat(300_000) }),
    );

    expect(res.status).toBe(413);
  });
});

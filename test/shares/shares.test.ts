import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, registerTestUser, resetDb } from '../helpers/app.js';

const { app, db } = createTestApp();

beforeEach(() => resetDb(db));
afterAll(() => db.destroy());

type TestUser = Awaited<ReturnType<typeof registerTestUser>>;

const as = (user: TestUser) => {
  const auth = `Bearer ${user.token}`;
  return {
    get: (path: string) => request(app).get(path).set('Authorization', auth),
    post: (path: string, body: object) =>
      request(app).post(path).set('Authorization', auth).send(body),
    put: (path: string, body: object) =>
      request(app).put(path).set('Authorization', auth).send(body),
    patch: (path: string, body: object, version = 1) =>
      request(app)
        .patch(path)
        .set('Authorization', auth)
        .set('If-Match', `"${version}"`)
        .send(body),
    delete: (path: string) => request(app).delete(path).set('Authorization', auth),
  };
};

let owner: TestUser;
let editor: TestUser;
let viewer: TestUser;
let teamMember: TestUser;
let stranger: TestUser;
let teamId: string;
let noteId: string;
let itemId: string;

beforeEach(async () => {
  owner = await registerTestUser(app, 'owner');
  editor = await registerTestUser(app, 'editor');
  viewer = await registerTestUser(app, 'viewer');
  teamMember = await registerTestUser(app, 'member');
  stranger = await registerTestUser(app, 'stranger');
  teamId = (await as(owner).post('/teams', { name: 'Platform' })).body.team.id;
  await as(owner).post(`/teams/${teamId}/members`, { email: teamMember.user.email });

  const note = await as(owner).post('/notes', { title: 'Plan', items: [{ text: 'milk' }] });
  noteId = note.body.note.id;
  itemId = note.body.note.items[0].id;
  await as(owner).put(`/notes/${noteId}/shares`, { userEmail: editor.user.email, role: 'editor' });
  await as(owner).put(`/notes/${noteId}/shares`, { userEmail: viewer.user.email, role: 'viewer' });
  await as(owner).put(`/notes/${noteId}/shares`, { teamId, role: 'viewer' });
});

describe('what each role can do', () => {
  const roles = () => ({ owner, editor, viewer, teamMember, stranger });

  it.each([
    ['owner', 200, 'owner'],
    ['editor', 200, 'editor'],
    ['viewer', 200, 'viewer'],
    ['teamMember', 200, 'viewer'],
    ['stranger', 404, undefined],
  ] as const)('%s reads the note: %i', async (who, status, role) => {
    const res = await as(roles()[who]).get(`/notes/${noteId}`);

    expect(res.status).toBe(status);
    expect(res.body.note?.role).toBe(role);
  });

  it.each([
    ['owner', 200],
    ['editor', 200],
    ['viewer', 403],
    ['teamMember', 403],
    ['stranger', 404],
  ] as const)('%s edits the note text: %i', async (who, status) => {
    expect((await as(roles()[who]).patch(`/notes/${noteId}`, { body: 'x' })).status).toBe(status);
  });

  it.each([
    ['owner', 200],
    ['editor', 200],
    ['viewer', 403],
    ['teamMember', 403],
    ['stranger', 404],
  ] as const)('%s ticks a checklist item: %i', async (who, status) => {
    const res = await as(roles()[who]).patch(`/notes/${noteId}/items/${itemId}`, { done: true });

    expect(res.status).toBe(status);
  });

  it.each([
    ['owner', 201],
    ['editor', 201],
    ['viewer', 403],
    ['teamMember', 403],
    ['stranger', 404],
  ] as const)('%s adds a checklist item: %i', async (who, status) => {
    expect((await as(roles()[who]).post(`/notes/${noteId}/items`, { text: 'x' })).status).toBe(
      status,
    );
  });

  it.each([
    ['editor', 403],
    ['viewer', 403],
    ['teamMember', 403],
    ['stranger', 404],
  ] as const)('%s cannot delete the note: %i', async (who, status) => {
    expect((await as(roles()[who]).delete(`/notes/${noteId}`)).status).toBe(status);
    expect((await as(owner).get(`/notes/${noteId}`)).status).toBe(200);
  });

  it.each([
    ['editor', 403],
    ['viewer', 403],
    ['teamMember', 403],
    ['stranger', 404],
  ] as const)('%s cannot see or change sharing: %i', async (who, status) => {
    const user = roles()[who];

    expect((await as(user).get(`/notes/${noteId}/shares`)).status).toBe(status);
    const grab = await as(user).put(`/notes/${noteId}/shares`, {
      userEmail: stranger.user.email,
      role: 'editor',
    });
    expect(grab.status).toBe(status);
  });
});

describe('effective role', () => {
  it('takes the highest of a direct grant and team grants', async () => {
    await as(owner).post(`/teams/${teamId}/members`, { email: viewer.user.email });
    await as(owner).put(`/notes/${noteId}/shares`, { teamId, role: 'editor' });

    expect((await as(viewer).get(`/notes/${noteId}`)).body.note.role).toBe('editor');
    expect((await as(viewer).patch(`/notes/${noteId}`, { title: 'ok' })).status).toBe(200);
  });

  it('follows team membership: leaving the team removes access', async () => {
    await as(teamMember).delete(`/teams/${teamId}/members/${teamMember.user.id}`);

    expect((await as(teamMember).get(`/notes/${noteId}`)).status).toBe(404);
  });

  it('removes team grants when the team is deleted', async () => {
    await as(owner).delete(`/teams/${teamId}`);

    expect((await as(teamMember).get(`/notes/${noteId}`)).status).toBe(404);
    const shares = (await as(owner).get(`/notes/${noteId}/shares`)).body.shares;
    expect(shares.map((s: { team: unknown }) => s.team)).toEqual([null, null]);
  });
});

describe('GET /notes scope', () => {
  it('splits owned and shared notes, each with the caller’s role', async () => {
    const own = (await as(editor).post('/notes', { title: 'Mine' })).body.note.id;

    const all = await as(editor).get('/notes');
    const owned = await as(editor).get('/notes?scope=owned');
    const shared = await as(editor).get('/notes?scope=shared');

    const summary = (res: request.Response) =>
      res.body.notes.map((n: { id: string; role: string }) => [n.id, n.role]).sort();
    expect(summary(all)).toEqual(
      [
        [noteId, 'editor'],
        [own, 'owner'],
      ].sort(),
    );
    expect(summary(owned)).toEqual([[own, 'owner']]);
    expect(summary(shared)).toEqual([[noteId, 'editor']]);
  });

  it('shows strangers nothing', async () => {
    expect((await as(stranger).get('/notes')).body.notes).toEqual([]);
  });

  it('rejects an unknown scope', async () => {
    expect((await as(owner).get('/notes?scope=everyone')).status).toBe(400);
  });
});

describe('managing shares', () => {
  it('lists grants with who they are for', async () => {
    const res = await as(owner).get(`/notes/${noteId}/shares`);

    expect(res.body.shares).toEqual([
      expect.objectContaining({
        role: 'editor',
        user: { id: editor.user.id, email: editor.user.email, displayName: 'editor' },
        team: null,
      }),
      expect.objectContaining({
        role: 'viewer',
        user: expect.objectContaining({ id: viewer.user.id }),
      }),
      expect.objectContaining({
        role: 'viewer',
        user: null,
        team: { id: teamId, name: 'Platform' },
      }),
    ]);
  });

  it('changes the role when the same grantee is shared again', async () => {
    const res = await as(owner).put(`/notes/${noteId}/shares`, {
      userEmail: viewer.user.email.toUpperCase(),
      role: 'editor',
    });

    expect(res.status).toBe(200);
    expect(res.body.share.role).toBe('editor');
    expect((await as(owner).get(`/notes/${noteId}/shares`)).body.shares).toHaveLength(3);
    expect((await as(viewer).patch(`/notes/${noteId}`, { title: 'ok' })).status).toBe(200);
  });

  it('revokes access when a share is deleted', async () => {
    const shares = (await as(owner).get(`/notes/${noteId}/shares`)).body.shares;
    const editorShare = shares.find(
      (s: { user: { id: string } | null }) => s.user?.id === editor.user.id,
    );

    expect((await as(owner).delete(`/notes/${noteId}/shares/${editorShare.id}`)).status).toBe(204);
    expect((await as(editor).get(`/notes/${noteId}`)).status).toBe(404);
  });

  it('refuses to grant a team the owner is not on', async () => {
    const otherTeam = (await as(stranger).post('/teams', { name: 'Theirs' })).body.team.id;
    const res = await as(owner).put(`/notes/${noteId}/shares`, {
      teamId: otherTeam,
      role: 'viewer',
    });

    expect(res.status).toBe(404);
    expect((await as(stranger).get(`/notes/${noteId}`)).status).toBe(404);
  });

  it.each([
    ['an unknown email', () => ({ userEmail: 'nobody@example.com' }), 404, 'user_not_found'],
    ['the owner', () => ({ userEmail: owner.user.email }), 400, 'cannot_share_with_owner'],
    [
      'a user and a team',
      () => ({ userEmail: editor.user.email, teamId }),
      400,
      'validation_failed',
    ],
    ['neither a user nor a team', () => ({}), 400, 'validation_failed'],
  ])('rejects sharing with %s', async (_label, grantee, status, code) => {
    const res = await as(owner).put(`/notes/${noteId}/shares`, { ...grantee(), role: 'viewer' });

    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
  });

  it('rejects the owner role', async () => {
    const res = await as(owner).put(`/notes/${noteId}/shares`, {
      userEmail: editor.user.email,
      role: 'owner',
    });

    expect(res.status).toBe(400);
  });

  it('returns 404 for a share on another note', async () => {
    const other = (await as(owner).post('/notes', { title: 'Other' })).body.note.id;
    const share = (
      await as(owner).put(`/notes/${other}/shares`, {
        userEmail: editor.user.email,
        role: 'viewer',
      })
    ).body.share;

    expect((await as(owner).delete(`/notes/${noteId}/shares/${share.id}`)).status).toBe(404);
    expect((await as(editor).get(`/notes/${other}`)).status).toBe(200);
  });
});

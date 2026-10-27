import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, registerTestUser, resetDb } from '../helpers/app.js';

const { app, db } = createTestApp();

beforeEach(() => resetDb(db));
afterAll(() => db.destroy());

type TestUser = Awaited<ReturnType<typeof registerTestUser>>;

const as = (user: TestUser) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${user.token}`),
  post: (path: string, body: object = {}) =>
    request(app).post(path).set('Authorization', `Bearer ${user.token}`).send(body),
  delete: (path: string) => request(app).delete(path).set('Authorization', `Bearer ${user.token}`),
});

/** Creates a team owned by `owner`, with `members` added as plain members. */
async function teamWith(owner: TestUser, members: TestUser[] = []) {
  const { body } = await as(owner).post('/teams', { name: 'Platform' });
  for (const member of members) {
    await as(owner).post(`/teams/${body.team.id}/members`, { email: member.user.email });
  }
  return body.team.id as string;
}

let owner: TestUser;
let member: TestUser;
let stranger: TestUser;

beforeEach(async () => {
  owner = await registerTestUser(app, 'owner');
  member = await registerTestUser(app, 'member');
  stranger = await registerTestUser(app, 'stranger');
});

describe('POST /teams', () => {
  it('creates a team with the caller as owner', async () => {
    const res = await as(owner).post('/teams', { name: 'Platform' });

    expect(res.status).toBe(201);
    expect(res.body.team).toMatchObject({ name: 'Platform', role: 'owner' });
  });

  it.each([
    ['a blank name', { name: '  ' }],
    ['a name with a newline', { name: 'a\nb' }],
    ['a name over 100 characters', { name: 'x'.repeat(101) }],
  ])('rejects %s', async (_label, body) => {
    const res = await as(owner).post('/teams', body);

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('name');
  });

  it('requires a token', async () => {
    expect((await request(app).post('/teams').send({ name: 'x' })).status).toBe(401);
  });
});

describe('GET /teams', () => {
  it("lists only the caller's teams with their role in each", async () => {
    const teamId = await teamWith(owner, [member]);
    await as(stranger).post('/teams', { name: 'Elsewhere' });

    const res = await as(member).get('/teams');

    expect(res.body.teams).toEqual([expect.objectContaining({ id: teamId, role: 'member' })]);
  });
});

describe('GET /teams/:id', () => {
  it('shows members to owners and members', async () => {
    const teamId = await teamWith(owner, [member]);

    for (const user of [owner, member]) {
      const res = await as(user).get(`/teams/${teamId}`);
      expect(res.status).toBe(200);
      expect(res.body.team.members).toEqual([
        { userId: owner.user.id, email: owner.user.email, displayName: 'owner', role: 'owner' },
        { userId: member.user.id, email: member.user.email, displayName: 'member', role: 'member' },
      ]);
    }
  });

  it('returns 404 to a stranger, the same as for a team that does not exist', async () => {
    const teamId = await teamWith(owner);
    const hidden = await as(stranger).get(`/teams/${teamId}`);
    const missing = await as(stranger).get('/teams/00000000-0000-4000-8000-000000000000');

    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
  });

  it('rejects an id that is not a UUID as a 400', async () => {
    expect((await as(owner).get('/teams/not-a-uuid')).status).toBe(400);
  });
});

describe('DELETE /teams/:id', () => {
  it('lets an owner delete the team, removing it for every member', async () => {
    const teamId = await teamWith(owner, [member]);

    expect((await as(owner).delete(`/teams/${teamId}`)).status).toBe(204);
    expect((await as(member).get('/teams')).body.teams).toEqual([]);
    const memberships = await db
      .selectFrom('teamMembers')
      .selectAll()
      .where('teamId', '=', teamId)
      .execute();
    expect(memberships).toEqual([]);
  });

  it('returns 403 to a member and 404 to a stranger, and keeps the team', async () => {
    const teamId = await teamWith(owner, [member]);

    expect((await as(member).delete(`/teams/${teamId}`)).status).toBe(403);
    expect((await as(stranger).delete(`/teams/${teamId}`)).status).toBe(404);
    expect((await as(owner).get(`/teams/${teamId}`)).status).toBe(200);
  });
});

describe('POST /teams/:id/members', () => {
  it('lets an owner add a user by email, in any case', async () => {
    const teamId = await teamWith(owner);
    const res = await as(owner).post(`/teams/${teamId}/members`, {
      email: member.user.email.toUpperCase(),
    });

    expect(res.status).toBe(201);
    expect(res.body.member).toMatchObject({ userId: member.user.id, role: 'member' });
  });

  it('lets an owner add another owner', async () => {
    const teamId = await teamWith(owner);
    const res = await as(owner).post(`/teams/${teamId}/members`, {
      email: member.user.email,
      role: 'owner',
    });

    expect(res.body.member.role).toBe('owner');
  });

  it('returns 403 to a member and 404 to a stranger', async () => {
    const teamId = await teamWith(owner, [member]);
    const body = { email: stranger.user.email };

    expect((await as(member).post(`/teams/${teamId}/members`, body)).status).toBe(403);
    expect((await as(stranger).post(`/teams/${teamId}/members`, body)).status).toBe(404);
  });

  it('rejects an unknown email and someone already on the team', async () => {
    const teamId = await teamWith(owner, [member]);
    const unknown = await as(owner).post(`/teams/${teamId}/members`, {
      email: 'nobody@example.com',
    });
    const duplicate = await as(owner).post(`/teams/${teamId}/members`, {
      email: member.user.email,
    });

    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('user_not_found');
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('already_member');
  });

  it('rejects an unknown role', async () => {
    const teamId = await teamWith(owner);
    const res = await as(owner).post(`/teams/${teamId}/members`, {
      email: member.user.email,
      role: 'admin',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('role');
  });
});

describe('DELETE /teams/:id/members/:userId', () => {
  it('lets an owner remove a member', async () => {
    const teamId = await teamWith(owner, [member]);

    expect((await as(owner).delete(`/teams/${teamId}/members/${member.user.id}`)).status).toBe(204);
    expect((await as(member).get(`/teams/${teamId}`)).status).toBe(404);
  });

  it('lets a member leave but not remove anyone else', async () => {
    const other = await registerTestUser(app, 'other');
    const teamId = await teamWith(owner, [member, other]);

    expect((await as(member).delete(`/teams/${teamId}/members/${other.user.id}`)).status).toBe(403);
    expect((await as(member).delete(`/teams/${teamId}/members/${member.user.id}`)).status).toBe(
      204,
    );
  });

  it('returns 404 to a stranger and for a user who is not on the team', async () => {
    const teamId = await teamWith(owner, [member]);

    expect((await as(stranger).delete(`/teams/${teamId}/members/${member.user.id}`)).status).toBe(
      404,
    );
    expect((await as(owner).delete(`/teams/${teamId}/members/${stranger.user.id}`)).status).toBe(
      404,
    );
  });

  it('keeps the last owner from leaving', async () => {
    const teamId = await teamWith(owner, [member]);
    const res = await as(owner).delete(`/teams/${teamId}/members/${owner.user.id}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('last_owner');
  });

  it('never lets two owners remove each other at the same time', async () => {
    const teamIds = await Promise.all(Array.from({ length: 20 }, () => teamWith(owner)));
    await Promise.all(
      teamIds.map((id) =>
        as(owner).post(`/teams/${id}/members`, { email: member.user.email, role: 'owner' }),
      ),
    );

    await Promise.all(
      teamIds.flatMap((id) => [
        as(owner).delete(`/teams/${id}/members/${member.user.id}`),
        as(member).delete(`/teams/${id}/members/${owner.user.id}`),
      ]),
    );

    const owners = await db
      .selectFrom('teamMembers')
      .select(['teamId', (eb) => eb.fn.countAll<number>().as('n')])
      .where('teamId', 'in', teamIds)
      .groupBy('teamId')
      .execute();
    expect(owners.map((row) => Number(row.n))).toEqual(teamIds.map(() => 1));
  });
});

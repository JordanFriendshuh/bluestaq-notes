import type { Db } from '../db/index.js';
import type { TeamRole } from '../db/types.js';
import { HttpError, notFound } from '../http/errors.js';
import type { AddMemberInput, CreateTeamInput } from './schemas.js';

export interface TeamSummary {
  id: string;
  name: string;
  role: TeamRole;
  createdAt: Date;
}

export interface TeamMember {
  userId: string;
  email: string;
  displayName: string;
  role: TeamRole;
}

export interface TeamDetail extends TeamSummary {
  members: TeamMember[];
}

const UNIQUE_VIOLATION = '23505';
const ownerOnly = () => new HttpError(403, 'forbidden', 'Only team owners can do this');

/** The caller's role in the team, or undefined if they aren't a member. */
export async function teamRole(
  db: Db,
  teamId: string,
  userId: string,
): Promise<TeamRole | undefined> {
  const row = await db
    .selectFrom('teamMembers')
    .select('role')
    .where('teamId', '=', teamId)
    .where('userId', '=', userId)
    .executeTakeFirst();
  return row?.role;
}

/** The caller's role, with a 404 for non-members so a team's existence doesn't leak. */
async function requireMember(db: Db, teamId: string, userId: string): Promise<TeamRole> {
  const role = await teamRole(db, teamId, userId);
  if (!role) throw notFound('Team');
  return role;
}

/** Creates a team with the caller as its only owner. */
export async function createTeam(
  db: Db,
  userId: string,
  input: CreateTeamInput,
): Promise<TeamSummary> {
  return db.transaction().execute(async (trx) => {
    const team = await trx
      .insertInto('teams')
      .values({ name: input.name, createdBy: userId })
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('teamMembers')
      .values({ teamId: team.id, userId, role: 'owner' })
      .execute();
    return { id: team.id, name: team.name, role: 'owner', createdAt: team.createdAt };
  });
}

/** Teams the caller belongs to, newest first. */
export async function listTeams(db: Db, userId: string): Promise<TeamSummary[]> {
  return db
    .selectFrom('teams')
    .innerJoin('teamMembers', 'teamMembers.teamId', 'teams.id')
    .select(['teams.id', 'teams.name', 'teamMembers.role', 'teams.createdAt'])
    .where('teamMembers.userId', '=', userId)
    .orderBy('teams.createdAt', 'desc')
    .orderBy('teams.id')
    .execute();
}

export async function getTeam(db: Db, userId: string, teamId: string): Promise<TeamDetail> {
  const role = await requireMember(db, teamId, userId);
  const team = await db
    .selectFrom('teams')
    .select(['id', 'name', 'createdAt'])
    .where('id', '=', teamId)
    .executeTakeFirstOrThrow();
  return { ...team, role, members: await listMembers(db, teamId) };
}

async function listMembers(db: Db, teamId: string): Promise<TeamMember[]> {
  return db
    .selectFrom('teamMembers')
    .innerJoin('users', 'users.id', 'teamMembers.userId')
    .select(['users.id as userId', 'users.email', 'users.displayName', 'teamMembers.role'])
    .where('teamMembers.teamId', '=', teamId)
    .orderBy('teamMembers.createdAt')
    .orderBy('users.id')
    .execute();
}

/** Deletes the team and its memberships; owners only. Returns the former members, who may have lost access. */
export async function deleteTeam(db: Db, callerId: string, teamId: string): Promise<string[]> {
  if ((await requireMember(db, teamId, callerId)) !== 'owner') throw ownerOnly();
  return db.transaction().execute(async (trx) => {
    const members = await trx
      .selectFrom('teamMembers')
      .select('userId')
      .where('teamId', '=', teamId)
      .execute();
    await trx.deleteFrom('teams').where('id', '=', teamId).execute();
    return members.map((member) => member.userId);
  });
}

/** Adds an existing user to the team by email; owners only. */
export async function addMember(
  db: Db,
  callerId: string,
  teamId: string,
  input: AddMemberInput,
): Promise<TeamMember> {
  if ((await requireMember(db, teamId, callerId)) !== 'owner') throw ownerOnly();

  const user = await db
    .selectFrom('users')
    .select(['id', 'email', 'displayName'])
    .where('email', '=', input.email)
    .executeTakeFirst();
  if (!user) throw new HttpError(404, 'user_not_found', 'No account has that email');

  try {
    await db
      .insertInto('teamMembers')
      .values({ teamId, userId: user.id, role: input.role })
      .execute();
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
      throw new HttpError(409, 'already_member', 'That user is already on the team');
    }
    throw err;
  }
  return { userId: user.id, email: user.email, displayName: user.displayName, role: input.role };
}

/**
 * Removes a member. Owners can remove anyone and members can remove themselves, but the last owner
 * can't leave. The team row is locked so two owners removing each other can't both succeed.
 */
export async function removeMember(
  db: Db,
  callerId: string,
  teamId: string,
  userId: string,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.selectFrom('teams').select('id').where('id', '=', teamId).forUpdate().execute();

    const callerRole = await requireMember(trx, teamId, callerId);
    if (callerId !== userId && callerRole !== 'owner') throw ownerOnly();

    const targetRole = await teamRole(trx, teamId, userId);
    if (!targetRole) throw notFound('Member');

    if (targetRole === 'owner') {
      const { owners } = await trx
        .selectFrom('teamMembers')
        .select((eb) => eb.fn.countAll<number>().as('owners'))
        .where('teamId', '=', teamId)
        .where('role', '=', 'owner')
        .executeTakeFirstOrThrow();
      if (Number(owners) <= 1) {
        throw new HttpError(409, 'last_owner', 'A team needs at least one owner');
      }
    }

    await trx
      .deleteFrom('teamMembers')
      .where('teamId', '=', teamId)
      .where('userId', '=', userId)
      .execute();
  });
}

import type { Db } from '../db/index.js';
import type { ShareRole } from '../db/types.js';
import { HttpError, notFound } from '../http/errors.js';
import { requireNoteRole } from '../notes/access.js';
import { teamRole } from '../teams/service.js';
import type { PutShareInput } from './schemas.js';

export interface Share {
  id: string;
  role: ShareRole;
  user: { id: string; email: string; displayName: string } | null;
  team: { id: string; name: string } | null;
  createdAt: Date;
}

/** Share management is owner-only; anyone else who can read the note gets 403, everyone else 404. */
async function requireOwner(db: Db, noteId: string, userId: string): Promise<void> {
  const role = await requireNoteRole(db, noteId, userId);
  if (role !== 'owner') throw new HttpError(403, 'forbidden', 'Only the owner can manage sharing');
}

export async function listShares(db: Db, userId: string, noteId: string): Promise<Share[]> {
  await requireOwner(db, noteId, userId);
  return sharesOf(db, noteId);
}

async function sharesOf(db: Db, noteId: string, shareId?: string): Promise<Share[]> {
  const rows = await db
    .selectFrom('noteShares')
    .leftJoin('users', 'users.id', 'noteShares.userId')
    .leftJoin('teams', 'teams.id', 'noteShares.teamId')
    .select([
      'noteShares.id',
      'noteShares.role',
      'noteShares.createdAt',
      'users.id as userId',
      'users.email',
      'users.displayName',
      'teams.id as teamId',
      'teams.name as teamName',
    ])
    .where('noteShares.noteId', '=', noteId)
    .$if(shareId !== undefined, (qb) => qb.where('noteShares.id', '=', shareId!))
    .orderBy('noteShares.createdAt')
    .orderBy('noteShares.id')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    user:
      row.userId && row.email && row.displayName
        ? { id: row.userId, email: row.email, displayName: row.displayName }
        : null,
    team: row.teamId && row.teamName ? { id: row.teamId, name: row.teamName } : null,
    createdAt: row.createdAt,
  }));
}

/**
 * Grants a user (by email) or a team a role on the note, or changes the role of an existing grant.
 * Only teams the owner belongs to can be granted, so nobody can push notes into a stranger's team.
 */
export async function putShare(
  db: Db,
  userId: string,
  noteId: string,
  input: PutShareInput,
): Promise<Share> {
  await requireOwner(db, noteId, userId);

  const grantee = input.userEmail
    ? { userId: await userIdByEmail(db, input.userEmail, userId), teamId: null }
    : { userId: null, teamId: await requireOwnTeam(db, input.teamId!, userId) };

  const { id } = await db
    .insertInto('noteShares')
    .values({ noteId, ...grantee, role: input.role })
    .onConflict((oc) =>
      (grantee.userId
        ? oc.columns(['noteId', 'userId'])
        : oc.columns(['noteId', 'teamId'])
      ).doUpdateSet({ role: input.role }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  const [share] = await sharesOf(db, noteId, id);
  return share!;
}

async function userIdByEmail(db: Db, email: string, ownerId: string): Promise<string> {
  const user = await db
    .selectFrom('users')
    .select('id')
    .where('email', '=', email)
    .executeTakeFirst();
  if (!user) throw new HttpError(404, 'user_not_found', 'No account has that email');
  if (user.id === ownerId) {
    throw new HttpError(400, 'cannot_share_with_owner', 'The owner already has full access');
  }
  return user.id;
}

async function requireOwnTeam(db: Db, teamId: string, userId: string): Promise<string> {
  if (!(await teamRole(db, teamId, userId))) throw notFound('Team');
  return teamId;
}

export async function deleteShare(
  db: Db,
  userId: string,
  noteId: string,
  shareId: string,
): Promise<void> {
  await requireOwner(db, noteId, userId);
  const deleted = await db
    .deleteFrom('noteShares')
    .where('id', '=', shareId)
    .where('noteId', '=', noteId)
    .executeTakeFirst();
  if (deleted.numDeletedRows === 0n) throw notFound('Share');
}

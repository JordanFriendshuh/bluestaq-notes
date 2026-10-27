import { sql } from 'kysely';
import type { Db } from '../db/index.js';
import { notFound } from '../http/errors.js';

export type NoteRole = 'owner' | 'editor' | 'viewer';

/**
 * Every note the user can reach and how: ownership, a direct grant, or a grant to one of their teams,
 * with the highest role per note. Each branch is an index lookup, and a filter on note_id is pushed
 * into all three, so this serves both "list my notes" and "can I open this one".
 */
function accessGrants(userId: string) {
  return sql<{ noteId: string; role: NoteRole }>`(
    SELECT note_id, (CASE max(rank) WHEN 3 THEN 'owner' WHEN 2 THEN 'editor' ELSE 'viewer' END) AS role
    FROM (
      SELECT id AS note_id, 3 AS rank FROM notes WHERE owner_id = ${userId}
      UNION ALL
      SELECT note_id, CASE role WHEN 'editor' THEN 2 ELSE 1 END
      FROM note_shares WHERE user_id = ${userId}
      UNION ALL
      SELECT s.note_id, CASE s.role WHEN 'editor' THEN 2 ELSE 1 END
      FROM note_shares s JOIN team_members tm ON tm.team_id = s.team_id
      WHERE tm.user_id = ${userId}
    ) grants
    GROUP BY note_id
  )`;
}

/**
 * Notes the caller can read with their effective role on each: owner, otherwise the highest role
 * across their direct grant and their teams' grants. The one place access is decided.
 */
export function readableNotes(db: Db, userId: string) {
  return db
    .selectFrom('notes')
    .innerJoin(accessGrants(userId).as('access'), 'access.noteId', 'notes.id')
    .select('access.role');
}

/** The caller's effective role on a note, or undefined if they can't read it. */
export async function noteRole(
  db: Db,
  noteId: string,
  userId: string,
): Promise<NoteRole | undefined> {
  const row = await readableNotes(db, userId).where('notes.id', '=', noteId).executeTakeFirst();
  return row?.role;
}

/** The caller's role, with a 404 when they can't read the note so its existence doesn't leak. */
export async function requireNoteRole(db: Db, noteId: string, userId: string): Promise<NoteRole> {
  const role = await noteRole(db, noteId, userId);
  if (!role) throw notFound('Note');
  return role;
}

export const canEdit = (role: NoteRole) => role === 'owner' || role === 'editor';

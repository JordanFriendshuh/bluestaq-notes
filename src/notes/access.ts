import { sql, type RawBuilder } from 'kysely';
import type { Db } from '../db/index.js';
import { notFound } from '../http/errors.js';

export type NoteRole = 'owner' | 'editor' | 'viewer';

/** Grants on `notes.id` to the user directly or to any team they belong to, optionally only editor grants. */
function grantsFor(userId: string, editorOnly: boolean): RawBuilder<unknown> {
  return sql`
    SELECT 1 FROM note_shares s
    WHERE s.note_id = notes.id
      AND (s.user_id = ${userId}
           OR s.team_id IN (SELECT tm.team_id FROM team_members tm WHERE tm.user_id = ${userId}))
      ${editorOnly ? sql`AND s.role = 'editor'` : sql``}`;
}

/**
 * Notes the caller can read with their effective role on each: owner, otherwise the highest role
 * across their direct grant and their teams' grants. The one place access is decided.
 */
export function readableNotes(db: Db, userId: string) {
  const role = sql<NoteRole>`CASE
    WHEN notes.owner_id = ${userId} THEN 'owner'
    WHEN EXISTS (${grantsFor(userId, true)}) THEN 'editor'
    ELSE 'viewer' END`;
  return (
    db
      .selectFrom('notes')
      .select(role.as('role'))
      // Parenthesized so filters chained on with AND apply to both halves of the OR.
      .where(sql<boolean>`(notes.owner_id = ${userId} OR EXISTS (${grantsFor(userId, false)}))`)
  );
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

import { sql } from 'kysely';
import type { Db } from '../db/index.js';
import { notFound } from '../http/errors.js';

export type NoteRole = 'owner' | 'editor' | 'viewer';

/** The caller's effective role on a note, or undefined if they can't read it. */
export async function noteRole(
  db: Db,
  noteId: string,
  userId: string,
): Promise<NoteRole | undefined> {
  const note = await db
    .selectFrom('notes')
    .select('ownerId')
    .where('id', '=', noteId)
    .executeTakeFirst();
  return note?.ownerId === userId ? 'owner' : undefined;
}

/** Notes the caller can read with their role on each, as a query to filter, sort and page further. */
export function readableNotes(db: Db, userId: string) {
  return db
    .selectFrom('notes')
    .select(sql<NoteRole>`'owner'`.as('role'))
    .where('notes.ownerId', '=', userId);
}

/** The caller's role, with a 404 when they can't read the note so its existence doesn't leak. */
export async function requireNoteRole(db: Db, noteId: string, userId: string): Promise<NoteRole> {
  const role = await noteRole(db, noteId, userId);
  if (!role) throw notFound('Note');
  return role;
}

export const canEdit = (role: NoteRole) => role === 'owner' || role === 'editor';

import { sql } from 'kysely';
import type { Db } from '../db/index.js';

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

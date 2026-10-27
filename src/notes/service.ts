import { sql } from 'kysely';
import type { Db } from '../db/index.js';
import type { NoteRow } from '../db/types.js';
import { HttpError, notFound } from '../http/errors.js';
import { noteRole, readableNotes, type NoteRole } from './access.js';
import type { CreateNoteInput, ListNotesInput, UpdateNoteInput } from './schemas.js';

export interface Note {
  id: string;
  ownerId: string;
  title: string;
  body: string;
  role: NoteRole;
  createdAt: Date;
  updatedAt: Date;
}

const canEdit = (role: NoteRole) => role === 'owner' || role === 'editor';
const toNote = (row: NoteRow, role: NoteRole): Note => ({ ...row, role });

/** The caller's role, with a 404 when they can't read the note so its existence doesn't leak. */
async function requireRole(db: Db, noteId: string, userId: string): Promise<NoteRole> {
  const role = await noteRole(db, noteId, userId);
  if (!role) throw notFound('Note');
  return role;
}

export async function createNote(db: Db, userId: string, input: CreateNoteInput): Promise<Note> {
  const row = await db
    .insertInto('notes')
    .values({ ownerId: userId, title: input.title, body: input.body })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toNote(row, 'owner');
}

/** Readable notes, most recently updated first. */
export async function listNotes(db: Db, userId: string, input: ListNotesInput): Promise<Note[]> {
  const rows = await readableNotes(db, userId)
    .selectAll('notes')
    .orderBy('notes.updatedAt', 'desc')
    .orderBy('notes.id')
    .limit(input.limit)
    .offset(input.offset)
    .execute();
  return rows;
}

export async function getNote(db: Db, userId: string, noteId: string): Promise<Note> {
  const role = await requireRole(db, noteId, userId);
  const row = await db
    .selectFrom('notes')
    .selectAll()
    .where('id', '=', noteId)
    .executeTakeFirstOrThrow();
  return toNote(row, role);
}

/** Changes only the fields sent; needs the editor role. */
export async function updateNote(
  db: Db,
  userId: string,
  noteId: string,
  input: UpdateNoteInput,
): Promise<Note> {
  const role = await requireRole(db, noteId, userId);
  if (!canEdit(role))
    throw new HttpError(403, 'forbidden', 'You can view this note but not edit it');

  const row = await db
    .updateTable('notes')
    .set({ ...input, updatedAt: sql`now()` })
    .where('id', '=', noteId)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw notFound('Note');
  return toNote(row, role);
}

/** Deletes a note; only its owner can. */
export async function deleteNote(db: Db, userId: string, noteId: string): Promise<void> {
  const role = await requireRole(db, noteId, userId);
  if (role !== 'owner') throw new HttpError(403, 'forbidden', 'Only the owner can delete a note');
  await db.deleteFrom('notes').where('id', '=', noteId).execute();
}

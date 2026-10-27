import { sql } from 'kysely';
import { insertInitialItems, itemsByNote, type ChecklistItem } from '../checklists/service.js';
import type { Db } from '../db/index.js';
import type { NoteRow } from '../db/types.js';
import { HttpError, notFound } from '../http/errors.js';
import { canEdit, readableNotes, requireNoteRole, type NoteRole } from './access.js';
import type { CreateNoteInput, ListNotesInput, UpdateNoteInput } from './schemas.js';

export interface Note {
  id: string;
  ownerId: string;
  title: string;
  body: string;
  items: ChecklistItem[];
  role: NoteRole;
  createdAt: Date;
  updatedAt: Date;
}

const toNote = (row: NoteRow, role: NoteRole, items: ChecklistItem[]): Note => ({
  ...row,
  items,
  role,
});

/** Creates a note and its starting checklist together. */
export async function createNote(db: Db, userId: string, input: CreateNoteInput): Promise<Note> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('notes')
      .values({ ownerId: userId, title: input.title, body: input.body })
      .returningAll()
      .executeTakeFirstOrThrow();
    const items = await insertInitialItems(trx, row.id, input.items);
    return toNote(row, 'owner', items);
  });
}

/** Readable notes with their checklists, most recently updated first. */
export async function listNotes(db: Db, userId: string, input: ListNotesInput): Promise<Note[]> {
  const rows = await readableNotes(db, userId)
    .selectAll('notes')
    .orderBy('notes.updatedAt', 'desc')
    .orderBy('notes.id')
    .limit(input.limit)
    .offset(input.offset)
    .execute();
  const items = await itemsByNote(
    db,
    rows.map((row) => row.id),
  );
  return rows.map(({ role, ...row }) => toNote(row, role, items.get(row.id) ?? []));
}

export async function getNote(db: Db, userId: string, noteId: string): Promise<Note> {
  const role = await requireNoteRole(db, noteId, userId);
  const row = await db
    .selectFrom('notes')
    .selectAll()
    .where('id', '=', noteId)
    .executeTakeFirstOrThrow();
  const items = await itemsByNote(db, [noteId]);
  return toNote(row, role, items.get(noteId) ?? []);
}

/** Changes only the fields sent; needs the editor role. Checklist items change through their own routes. */
export async function updateNote(
  db: Db,
  userId: string,
  noteId: string,
  input: UpdateNoteInput,
): Promise<Note> {
  const role = await requireNoteRole(db, noteId, userId);
  if (!canEdit(role))
    throw new HttpError(403, 'forbidden', 'You can view this note but not edit it');

  const row = await db
    .updateTable('notes')
    .set({ ...input, updatedAt: sql`now()` })
    .where('id', '=', noteId)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw notFound('Note');
  const items = await itemsByNote(db, [noteId]);
  return toNote(row, role, items.get(noteId) ?? []);
}

/** Deletes a note and its checklist; only its owner can. */
export async function deleteNote(db: Db, userId: string, noteId: string): Promise<void> {
  const role = await requireNoteRole(db, noteId, userId);
  if (role !== 'owner') throw new HttpError(403, 'forbidden', 'Only the owner can delete a note');
  await db.deleteFrom('notes').where('id', '=', noteId).execute();
}

import { sql } from 'kysely';
import { insertInitialItems, itemsByNote, type ChecklistItem } from '../checklists/service.js';
import type { Db } from '../db/index.js';
import type { NoteRow } from '../db/types.js';
import { HttpError } from '../http/errors.js';
import { versionConflict } from '../http/preconditions.js';
import { canEdit, readableNotes, requireNoteRole, type NoteRole } from './access.js';
import type { CreateNoteInput, ListNotesInput, UpdateNoteInput } from './schemas.js';

export interface Note {
  id: string;
  ownerId: string;
  title: string;
  body: string;
  version: number;
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

/** Readable notes with their checklists, most recently updated first; `scope` narrows to owned or shared. */
export async function listNotes(db: Db, userId: string, input: ListNotesInput): Promise<Note[]> {
  const rows = await readableNotes(db, userId)
    .$if(input.scope === 'owned', (qb) => qb.where('notes.ownerId', '=', userId))
    .$if(input.scope === 'shared', (qb) => qb.where('notes.ownerId', '!=', userId))
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

/**
 * Changes only the fields sent if the note is still at `expectedVersion`, then bumps the version;
 * a stale version is a 409 with the current note. Needs the editor role.
 */
export async function updateNote(
  db: Db,
  userId: string,
  noteId: string,
  expectedVersion: number,
  input: UpdateNoteInput,
): Promise<Note> {
  const role = await requireNoteRole(db, noteId, userId);
  if (!canEdit(role))
    throw new HttpError(403, 'forbidden', 'You can view this note but not edit it');

  const row = await db
    .updateTable('notes')
    .set({ ...input, version: sql`version + 1`, updatedAt: sql`now()` })
    .where('id', '=', noteId)
    .where('version', '=', expectedVersion)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw versionConflict(await getNote(db, userId, noteId));
  const items = await itemsByNote(db, [noteId]);
  return toNote(row, role, items.get(noteId) ?? []);
}

/** Deletes a note and its checklist; only its owner can. */
export async function deleteNote(db: Db, userId: string, noteId: string): Promise<void> {
  const role = await requireNoteRole(db, noteId, userId);
  if (role !== 'owner') throw new HttpError(403, 'forbidden', 'Only the owner can delete a note');
  await db.deleteFrom('notes').where('id', '=', noteId).execute();
}

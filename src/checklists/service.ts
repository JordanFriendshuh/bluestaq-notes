import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { sql } from 'kysely';
import type { Db } from '../db/index.js';
import { HttpError, notFound } from '../http/errors.js';
import { canEdit, requireNoteRole } from '../notes/access.js';
import {
  MAX_ITEMS,
  type AddItemInput,
  type NewItemsInput,
  type UpdateItemInput,
} from './schemas.js';

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

const ITEM_COLUMNS = ['id', 'text', 'done'] as const;

/** Inserts a new note's starting items in the order given. */
export async function insertInitialItems(
  db: Db,
  noteId: string,
  items: NewItemsInput,
): Promise<ChecklistItem[]> {
  if (items.length === 0) return [];
  const positions = generateNKeysBetween(null, null, items.length);
  return db
    .insertInto('noteItems')
    .values(
      items.map((item, i) => ({
        noteId,
        text: item.text,
        done: item.done,
        position: positions[i]!,
      })),
    )
    .returning(ITEM_COLUMNS)
    .execute();
}

/** Items for each of the given notes in list order, fetched in one query. */
export async function itemsByNote(
  db: Db,
  noteIds: string[],
): Promise<Map<string, ChecklistItem[]>> {
  const byNote = new Map<string, ChecklistItem[]>(noteIds.map((id) => [id, []]));
  if (noteIds.length === 0) return byNote;
  const rows = await db
    .selectFrom('noteItems')
    .select(['noteId', ...ITEM_COLUMNS])
    .where('noteId', 'in', noteIds)
    .orderBy('noteId')
    .orderBy('position')
    .execute();
  for (const { noteId, ...item } of rows) byNote.get(noteId)?.push(item);
  return byNote;
}

/**
 * Checks edit access, then bumps the note's updated_at. That update also locks the note row, so item
 * writes on one note run one at a time and two inserts can't pick the same position.
 */
async function lockNoteForEdit(db: Db, noteId: string, userId: string): Promise<void> {
  const role = await requireNoteRole(db, noteId, userId);
  if (!canEdit(role))
    throw new HttpError(403, 'forbidden', 'You can view this note but not edit it');
  await db
    .updateTable('notes')
    .set({ updatedAt: sql`now()` })
    .where('id', '=', noteId)
    .execute();
}

/** A position key for an item placed after `after` (null = top, undefined = bottom), skipping `movingId`. */
async function positionFor(
  db: Db,
  noteId: string,
  after: string | null | undefined,
  movingId?: string,
): Promise<string> {
  const siblings = db
    .selectFrom('noteItems')
    .select('position')
    .where('noteId', '=', noteId)
    .$if(movingId !== undefined, (qb) => qb.where('id', '!=', movingId!));

  if (after === undefined) {
    const last = await siblings.orderBy('position', 'desc').limit(1).executeTakeFirst();
    return generateKeyBetween(last?.position ?? null, null);
  }

  let previous: string | null = null;
  if (after !== null) {
    if (after === movingId) throw invalidPosition('An item cannot be placed after itself');
    const anchor = await siblings.where('id', '=', after).executeTakeFirst();
    if (!anchor) throw invalidPosition('after must be an item in this note');
    previous = anchor.position;
  }
  const next = await siblings
    .$if(previous !== null, (qb) => qb.where('position', '>', previous!))
    .orderBy('position')
    .limit(1)
    .executeTakeFirst();
  return generateKeyBetween(previous, next?.position ?? null);
}

const invalidPosition = (message: string) => new HttpError(400, 'invalid_position', message);

export async function addItem(
  db: Db,
  userId: string,
  noteId: string,
  input: AddItemInput,
): Promise<ChecklistItem> {
  return db.transaction().execute(async (trx) => {
    await lockNoteForEdit(trx, noteId, userId);

    const { count } = await trx
      .selectFrom('noteItems')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('noteId', '=', noteId)
      .executeTakeFirstOrThrow();
    if (Number(count) >= MAX_ITEMS) {
      throw new HttpError(409, 'checklist_full', `A checklist holds at most ${MAX_ITEMS} items`);
    }

    const position = await positionFor(trx, noteId, input.after);
    return trx
      .insertInto('noteItems')
      .values({ noteId, text: input.text, done: input.done, position })
      .returning(ITEM_COLUMNS)
      .executeTakeFirstOrThrow();
  });
}

/** Changes an item's text or done flag, or moves it with `after`. */
export async function updateItem(
  db: Db,
  userId: string,
  noteId: string,
  itemId: string,
  input: UpdateItemInput,
): Promise<ChecklistItem> {
  return db.transaction().execute(async (trx) => {
    await lockNoteForEdit(trx, noteId, userId);
    await requireItem(trx, noteId, itemId);

    const { after, ...fields } = input;
    const position =
      after === undefined ? undefined : await positionFor(trx, noteId, after, itemId);
    return trx
      .updateTable('noteItems')
      .set({ ...fields, ...(position && { position }), updatedAt: sql`now()` })
      .where('id', '=', itemId)
      .returning(ITEM_COLUMNS)
      .executeTakeFirstOrThrow();
  });
}

export async function deleteItem(
  db: Db,
  userId: string,
  noteId: string,
  itemId: string,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await lockNoteForEdit(trx, noteId, userId);
    await requireItem(trx, noteId, itemId);
    await trx.deleteFrom('noteItems').where('id', '=', itemId).execute();
  });
}

async function requireItem(db: Db, noteId: string, itemId: string): Promise<void> {
  const item = await db
    .selectFrom('noteItems')
    .select('id')
    .where('id', '=', itemId)
    .where('noteId', '=', noteId)
    .executeTakeFirst();
  if (!item) throw notFound('Item');
}

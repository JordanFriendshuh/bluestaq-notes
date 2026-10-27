import { sql, type RawBuilder } from 'kysely';
import { itemsByNote } from '../checklists/service.js';
import type { Db } from '../db/index.js';
import { readableNotes } from '../notes/access.js';
import type { ListNotesInput } from '../notes/schemas.js';
import { NOTE_COLUMNS, type Note } from '../notes/service.js';
import {
  allWordsQuery,
  HEADLINE_OPTIONS,
  queryWords,
  snippetParts,
  wordQuery,
  type SnippetPart,
} from './query.js';

export interface SearchResult extends Note {
  snippet: SnippetPart[];
}

/** Similarity (0–1) at or above which a query word counts as a typo of a word in the title. */
const TITLE_SIMILARITY = 0.4;
/** Item matches count for less than matches in the note's own title or body. */
const ITEM_WEIGHT = 0.5;

/** A word matches if it prefixes a word of the title, body or an item, or is a typo of a title word. */
function wordMatches(word: string): RawBuilder<boolean> {
  const wq = wordQuery(word);
  return sql<boolean>`(notes.search @@ ${wq}
    OR EXISTS (SELECT 1 FROM note_items i WHERE i.note_id = notes.id AND i.search @@ ${wq})
    OR word_similarity(${word}, notes.title) >= ${TITLE_SIMILARITY})`;
}

/**
 * Ranked search over the caller's readable notes. Every word of the query must match (see
 * wordMatches); results are ordered by text rank, item rank and title similarity, best first.
 */
export async function searchNotes(
  db: Db,
  userId: string,
  input: ListNotesInput & { q: string },
): Promise<SearchResult[]> {
  const words = queryWords(input.q);
  if (words.length === 0) return [];
  const tsq = allWordsQuery(words);
  const itemRank = sql`(SELECT max(ts_rank(i.search, ${tsq})) FROM note_items i
    WHERE i.note_id = notes.id AND i.search @@ ${tsq})`;

  const rows = await readableNotes(db, userId)
    .$if(input.scope === 'owned', (qb) => qb.where('notes.ownerId', '=', userId))
    .$if(input.scope === 'shared', (qb) => qb.where('notes.ownerId', '!=', userId))
    .where(sql<boolean>`(${sql.join(words.map(wordMatches), sql` AND `)})`)
    .select(NOTE_COLUMNS)
    .select(
      sql<number>`ts_rank(notes.search, ${tsq}) + coalesce(${itemRank}, 0) * ${ITEM_WEIGHT}
        + word_similarity(${input.q}, notes.title)`.as('rank'),
    )
    .orderBy('rank', 'desc')
    .orderBy('notes.updatedAt', 'desc')
    .orderBy('notes.id')
    .limit(input.limit)
    .offset(input.offset)
    .execute();

  const ids = rows.map((row) => row.id);
  const [items, snippets] = await Promise.all([itemsByNote(db, ids), headlines(db, ids, tsq)]);
  return rows.map(({ rank: _rank, role, ...row }) => ({
    ...row,
    role,
    items: items.get(row.id) ?? [],
    snippet: snippetParts(snippets.get(row.id) ?? ''),
  }));
}

/** Highlighted excerpts of each note's body and checklist text, computed only for the page of results. */
async function headlines(db: Db, ids: string[], tsq: RawBuilder<unknown>) {
  if (ids.length === 0) return new Map<string, string>();
  const rows = await db
    .selectFrom('notes')
    .select([
      'id',
      sql<string>`ts_headline('simple',
        notes.body || E'\n' || coalesce((SELECT string_agg(i.text, E'\n' ORDER BY i.position)
                                         FROM note_items i WHERE i.note_id = notes.id), ''),
        ${tsq}, ${HEADLINE_OPTIONS})`.as('headline'),
    ])
    .where('id', 'in', ids)
    .execute();
  return new Map(rows.map((row) => [row.id, row.headline.trim()]));
}

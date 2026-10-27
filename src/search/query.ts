import { sql, type RawBuilder } from 'kysely';

/** At most this many words of a query are used; the rest are ignored. */
export const MAX_QUERY_WORDS = 8;

/** Words of a search box query: runs of letters and digits, lower-cased, so no tsquery syntax gets through. */
export function queryWords(q: string): string[] {
  return (
    q
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).slice(0, MAX_QUERY_WORDS);
}

/** A tsquery matching the word as a prefix, as typed ('simple') or stemmed ('english'), like the index. */
export function wordQuery(word: string): RawBuilder<unknown> {
  return sql`(to_tsquery('simple', ${`${word}:*`}) || to_tsquery('english', ${`${word}:*`}))`;
}

/** A tsquery where every word must match; used for ranking and highlighting. */
export function allWordsQuery(words: string[]): RawBuilder<unknown> {
  return sql`(${sql.join(words.map(wordQuery), sql` && `)})`;
}

// Highlight markers: control characters that note text can never contain (input hygiene rejects them).
export const HIGHLIGHT_START = '\u0002';
export const HIGHLIGHT_STOP = '\u0003';
export const HEADLINE_OPTIONS = `StartSel=${HIGHLIGHT_START}, StopSel=${HIGHLIGHT_STOP}, MaxWords=24, MinWords=8, MaxFragments=2, FragmentDelimiter=" … "`;

export interface SnippetPart {
  text: string;
  highlight: boolean;
}

/** Splits ts_headline output into plain-text parts, so clients never have to render markup. */
export function snippetParts(headline: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  for (const [i, chunk] of headline.split(HIGHLIGHT_START).entries()) {
    const [highlighted, rest] = i === 0 ? [undefined, chunk] : chunk.split(HIGHLIGHT_STOP, 2);
    if (highlighted) parts.push({ text: highlighted, highlight: true });
    if (rest) parts.push({ text: rest, highlight: false });
  }
  return parts;
}

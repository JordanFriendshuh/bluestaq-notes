import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { HIGHLIGHT_START, HIGHLIGHT_STOP } from '../../src/search/query.js';
import { createTestApp, registerTestUser, resetDb } from '../helpers/app.js';

const { app, db } = createTestApp();

beforeEach(() => resetDb(db));
afterAll(() => db.destroy());

type TestUser = Awaited<ReturnType<typeof registerTestUser>>;
interface Result {
  id: string;
  title: string;
  role: string;
  items: { text: string }[];
  snippet: { text: string; highlight: boolean }[];
}

let owner: TestUser;

beforeEach(async () => {
  owner = await registerTestUser(app, 'owner');
});

async function note(title: string, body = '', items: string[] = [], user = owner) {
  const res = await request(app)
    .post('/notes')
    .set('Authorization', `Bearer ${user.token}`)
    .send({ title, body, items: items.map((text) => ({ text })) });
  return res.body.note.id as string;
}

async function search(q: string, user = owner, extra = '') {
  const res = await request(app)
    .get(`/notes?q=${encodeURIComponent(q)}${extra}`)
    .set('Authorization', `Bearer ${user.token}`);
  expect(res.status).toBe(200);
  return res.body.notes as Result[];
}

const titles = (results: Result[]) => results.map((r) => r.title);

describe('search as you type', () => {
  it.each(['m', 'mee', 'meetin', 'meeting', 'MEETING'])('finds "meeting" from "%s"', async (q) => {
    await note('Weekly meeting');
    await note('Grocery list');

    expect(titles(await search(q))).toEqual(['Weekly meeting']);
  });

  it('matches other forms of a word through stemming', async () => {
    await note('Planning', 'We met to plan the roadmap and discuss budgets');

    expect(titles(await search('budget'))).toEqual(['Planning']);
    expect(titles(await search('planned roadmaps'))).toEqual(['Planning']);
  });

  it('tolerates typos in the title', async () => {
    await note('Team meeting');

    expect(titles(await search('meetng'))).toEqual(['Team meeting']);
    expect(titles(await search('team meetnig'))).toEqual(['Team meeting']);
  });

  it('requires every word to match', async () => {
    await note('Roadmap', 'budget review for Q3');
    await note('Roadmap draft', 'nothing about money');

    expect(titles(await search('roadmap budget'))).toEqual(['Roadmap']);
  });

  it('searches checklist items', async () => {
    await note('Groceries', '', ['oat milk', 'sourdough bread']);

    const [result] = await search('sourdough');
    expect(result?.title).toBe('Groceries');
    expect(result?.snippet).toContainEqual({ text: 'sourdough', highlight: true });
  });

  it('finds edits immediately', async () => {
    const id = await note('Draft', 'old words');
    await request(app)
      .patch(`/notes/${id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .set('If-Match', '"1"')
      .send({ body: 'fresh words' });

    expect(titles(await search('fresh'))).toEqual(['Draft']);
    expect(await search('old')).toEqual([]);
  });
});

describe('ranking', () => {
  it('puts title matches above body matches above checklist matches', async () => {
    await note('Shopping', '', ['budget spreadsheet']);
    await note('Notes', 'the budget is tight');
    await note('Budget', 'quarterly numbers');

    expect(titles(await search('budget'))).toEqual(['Budget', 'Notes', 'Shopping']);
  });
});

describe('snippets', () => {
  it('returns plain-text parts with the matches flagged', async () => {
    await note('Retro', 'What went well: the deploy pipeline. What to fix: flaky deploys.');

    const [result] = await search('deploy');

    const highlighted = result!.snippet.filter((p) => p.highlight).map((p) => p.text);
    expect(highlighted).toEqual(['deploy', 'deploys']);
    const text = result!.snippet.map((p) => p.text).join('');
    expect(text).not.toContain(HIGHLIGHT_START);
    expect(text).not.toContain(HIGHLIGHT_STOP);
  });

  it('drops HTML-looking tags from snippets rather than passing markup on', async () => {
    await note('Retro', 'the <b onclick="x()">deploy</b> pipeline');

    const [result] = await search('deploy');

    expect(result!.snippet.map((p) => p.text).join('')).not.toContain('<');
  });
});

describe('access', () => {
  it('only searches notes the caller can read, with their role on each', async () => {
    const other = await registerTestUser(app, 'other');
    const shared = await note('Shared budget', '', [], other);
    await note('Private budget', '', [], other);
    await request(app)
      .put(`/notes/${shared}/shares`)
      .set('Authorization', `Bearer ${other.token}`)
      .send({ userEmail: owner.user.email, role: 'viewer' });
    await note('My budget');

    const results = await search('budget');

    expect(results.map((r) => [r.title, r.role]).sort()).toEqual([
      ['My budget', 'owner'],
      ['Shared budget', 'viewer'],
    ]);
    expect(titles(await search('budget', owner, '&scope=shared'))).toEqual(['Shared budget']);
  });

  it('finds nothing for a stranger', async () => {
    const stranger = await registerTestUser(app, 'stranger');
    await note('Budget');

    expect(await search('budget', stranger)).toEqual([]);
  });
});

describe('queries', () => {
  it.each(['!!!', '   -- ', '&|!():*'])(
    'returns nothing for "%s", which has no words',
    async (q) => {
      await note('Anything');

      expect(await search(q)).toEqual([]);
    },
  );

  it('pages results', async () => {
    for (const title of ['plan a', 'plan b', 'plan c']) await note(title);

    const page = await search('plan', owner, '&limit=2&offset=2');
    expect(page).toHaveLength(1);
  });

  it('rejects a query over 200 characters', async () => {
    const res = await request(app)
      .get(`/notes?q=${'x'.repeat(201)}`)
      .set('Authorization', `Bearer ${owner.token}`);

    expect(res.status).toBe(400);
  });
});

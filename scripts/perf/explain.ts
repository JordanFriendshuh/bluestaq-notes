/**
 * SQL efficiency review: builds a throwaway `notes_perf` database at realistic volume (seed.sql),
 * runs the real service functions as a busy user, captures every query they send and prints
 * EXPLAIN ANALYZE for each. Writes are explained inside a rolled-back transaction.
 *
 * Usage: npm run perf:explain [-- --verbose]   (needs the compose database running)
 */
import { readFileSync } from 'node:fs';
import { CamelCasePlugin, Kysely, PostgresDialect, type LogEvent } from 'kysely';
import { addItem, updateItem } from '../../src/checklists/service.js';
import { createPool } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { Database } from '../../src/db/types.js';
import { noteRole } from '../../src/notes/access.js';
import { getNote, listNotes, updateNote } from '../../src/notes/service.js';
import { searchNotes } from '../../src/search/service.js';
import { listShares } from '../../src/shares/service.js';
import { getTeam, listTeams } from '../../src/teams/service.js';

const ADMIN_URL = process.env.PERF_ADMIN_URL ?? 'postgres://notes:notes@localhost:5432/notes';
const PERF_URL = ADMIN_URL.replace(/\/[^/]+$/, '/notes_perf');
const TLS = { mode: 'verify' as const, caFile: process.env.PERF_CA_FILE ?? 'secrets/ca.crt' };
const verbose = process.argv.includes('--verbose');

interface Captured {
  sql: string;
  parameters: readonly unknown[];
}

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  Plans?: PlanNode[];
}

async function createPerfDatabase() {
  const admin = createPool(ADMIN_URL, TLS);
  await admin.query('DROP DATABASE IF EXISTS notes_perf');
  await admin.query('CREATE DATABASE notes_perf');
  await admin.end();

  const pool = createPool(PERF_URL, TLS);
  await runMigrations(pool);
  const client = await pool.connect();
  const started = Date.now();
  await client.query(readFileSync(new URL('./seed.sql', import.meta.url), 'utf8'));
  client.release();
  const { rows } = await pool.query(`SELECT
    (SELECT count(*) FROM users) users, (SELECT count(*) FROM teams) teams,
    (SELECT count(*) FROM notes) notes, (SELECT count(*) FROM note_items) items,
    (SELECT count(*) FROM note_shares) shares`);
  console.log(`seeded in ${((Date.now() - started) / 1000).toFixed(1)}s:`, rows[0]);
  return pool;
}

/** Sequential scans on the big tables, with rows produced; the usual sign of a missing index. */
function seqScans(node: PlanNode, found: string[] = []): string[] {
  const big = ['notes', 'note_items', 'note_shares', 'team_members', 'users'];
  if (node['Node Type'] === 'Seq Scan' && big.includes(node['Relation Name'] ?? '')) {
    found.push(`${node['Relation Name']} (${node['Actual Rows'] * node['Actual Loops']} rows out)`);
  }
  for (const child of node.Plans ?? []) seqScans(child, found);
  return found;
}

async function main() {
  const pool = await createPerfDatabase();
  let captured: Captured[] = [];
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
    log: (event: LogEvent) => {
      // Transaction control statements are logged too but can't be explained.
      if (event.level === 'query' && !/^(begin|commit|rollback)\b/i.test(event.query.sql)) {
        captured.push({ sql: event.query.sql, parameters: event.query.parameters });
      }
    },
  });

  const active = await db
    .selectFrom('users')
    .select('id')
    .where('email', '=', 'active@example.com')
    .executeTakeFirstOrThrow();
  const uid = active.id;
  const own = await db
    .selectFrom('notes')
    .innerJoin('noteItems', 'noteItems.noteId', 'notes.id')
    .select([
      'notes.id',
      'notes.version',
      'noteItems.id as itemId',
      'noteItems.version as itemVersion',
    ])
    .where('notes.ownerId', '=', uid)
    .limit(1)
    .executeTakeFirstOrThrow();
  const viaTeam = await db
    .selectFrom('noteShares')
    .innerJoin('teamMembers', 'teamMembers.teamId', 'noteShares.teamId')
    .select('noteShares.noteId')
    .where('teamMembers.userId', '=', uid)
    .limit(1)
    .executeTakeFirstOrThrow();
  const team = (await listTeams(db, uid))[0]!;
  const page = { scope: 'all' as const, limit: 50, offset: 0 };

  const scenarios: [string, () => Promise<unknown>][] = [
    ['GET /notes (first page)', () => listNotes(db, uid, page)],
    ['GET /notes?scope=shared', () => listNotes(db, uid, { ...page, scope: 'shared' })],
    ['GET /notes?offset=600', () => listNotes(db, uid, { ...page, offset: 600 })],
    ['GET /notes/:id (via a team grant)', () => getNote(db, uid, viaTeam.noteId)],
    ['WebSocket join (noteRole)', () => noteRole(db, viaTeam.noteId, uid)],
    ['PATCH /notes/:id', () => updateNote(db, uid, own.id, own.version, { title: 'Renamed' })],
    ['search "meeting" (common word)', () => searchNotes(db, uid, { ...page, q: 'meeting' })],
    [
      'search "budget review" (two words)',
      () => searchNotes(db, uid, { ...page, q: 'budget review' }),
    ],
    ['search "dep" (prefix while typing)', () => searchNotes(db, uid, { ...page, q: 'dep' })],
    ['search "budegt" (title typo)', () => searchNotes(db, uid, { ...page, q: 'budegt' })],
    ['search "zzqx" (no match)', () => searchNotes(db, uid, { ...page, q: 'zzqx' })],
    [
      'POST /notes/:id/items (after first)',
      () => addItem(db, uid, own.id, { text: 'new', done: false, after: own.itemId }),
    ],
    [
      'PATCH item (move to top)',
      () => updateItem(db, uid, own.id, own.itemId, own.itemVersion, { after: null }),
    ],
    ['GET /teams', () => listTeams(db, uid)],
    ['GET /teams/:id', () => getTeam(db, uid, team.id)],
    ['GET /notes/:id/shares', () => listShares(db, uid, own.id)],
  ];

  const summary: string[] = [];
  for (const [label, run] of scenarios) {
    captured = [];
    await run();
    let total = 0;
    console.log(`\n=== ${label}`);
    for (const query of captured) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const explained = await client
          .query(
            `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
            query.parameters as unknown[],
          )
          .catch((err: Error) => err);
        await client.query('ROLLBACK');
        // Repeating an insert the service already made can hit a unique key; report and move on.
        if (explained instanceof Error) {
          console.log(`  (not re-run: ${explained.message})  ${query.sql.slice(0, 60)}`);
          continue;
        }
        const { rows } = explained;
        const plan = rows[0]['QUERY PLAN'][0];
        total += plan['Execution Time'];
        const scans = seqScans(plan.Plan);
        const sqlLine = query.sql.replace(/\s+/g, ' ').slice(0, 90);
        console.log(
          `  ${plan['Execution Time'].toFixed(2).padStart(8)} ms  ${sqlLine}` +
            (scans.length ? `\n              seq scan: ${scans.join(', ')}` : ''),
        );
        if (verbose) {
          const text = await client.query(
            `EXPLAIN (ANALYZE, BUFFERS) ${query.sql}`,
            query.parameters as unknown[],
          );
          await client.query('ROLLBACK').catch(() => {});
          console.log(text.rows.map((r) => `      ${r['QUERY PLAN']}`).join('\n'));
        }
      } finally {
        client.release();
      }
    }
    summary.push(`${total.toFixed(1).padStart(8)} ms  ${captured.length} queries  ${label}`);
  }
  console.log('\n=== Summary (sum of execution times per request)\n' + summary.join('\n'));
  await db.destroy();
}

await main();

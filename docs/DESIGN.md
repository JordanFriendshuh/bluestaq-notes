# Design

## Scope
**In:** accounts and auth, teams, notes with optional checklists, sharing notes with users or teams
as viewer or editor, full-text search, optimistic concurrency, live presence and cursors.

**Out (README "more time" list):** attachments (S3 + presigned URLs), real-time co-editing of content
(CRDT/Yjs), organizations/tenancy, refresh tokens, notebooks as a shared unit, semantic search.

## Data model (PostgreSQL)
```
users        id uuid pk, email citext unique, display_name, password_hash, created_at
teams        id uuid pk, name, created_by -> users, created_at
team_members team_id -> teams, user_id -> users, role ('owner'|'member'), pk(team_id, user_id)
notes        id uuid pk, owner_id -> users, title, body, items jsonb default '[]',
             version int default 1, created_at, updated_at,
             search tsvector generated (title weight A, body B, item text C)
note_shares  id uuid pk, note_id -> notes on delete cascade,
             user_id -> users null, team_id -> teams null,
             role ('viewer'|'editor'), created_at,
             check (exactly one of user_id, team_id), unique per (note, user) and (note, team)
```
- **Checklists live inside the note** as `items: [{ id, text, done }]`. A note can be prose, a list, or both.
- **Shares use two nullable foreign keys, not a polymorphic `principal_id`**, so Postgres enforces
  referential integrity and deleting a user or team cleans up its grants.
- **Effective role** = owner if `owner_id` matches, otherwise the highest role across the caller's direct
  grant and the grants of every team they belong to. One SQL function/CTE computes it (`notes/access.ts`).

## Permissions
| Action                      | Owner | Editor | Viewer |
|-----------------------------|:-----:|:------:|:------:|
| Read note                   | ✓     | ✓      | ✓      |
| Edit title, body, items     | ✓     | ✓      |        |
| Delete note                 | ✓     |        |        |
| Add or remove shares        | ✓     |        |        |

Teams: anyone can create one and becomes its owner. Team owners add and remove members by email.
Members can see the team and its member list.

## API
All JSON. Auth is `Authorization: Bearer <jwt>` everywhere except register, login and health.
```
POST   /auth/register           { email, password, displayName } -> { token, user }
POST   /auth/login              { email, password } -> { token, user }
GET    /me

POST   /teams                   GET /teams          GET /teams/:id
POST   /teams/:id/members       { email, role }
DELETE /teams/:id/members/:userId

POST   /notes                   { title, body?, items? }
GET    /notes                   ?q=&scope=all|owned|shared&limit=&offset=
GET    /notes/:id               -> ETag: "<version>"
PATCH  /notes/:id               If-Match required; partial { title?, body?, items? }
DELETE /notes/:id

GET    /notes/:id/shares
PUT    /notes/:id/shares        { userEmail | teamId, role }  (upsert)
DELETE /notes/:id/shares/:shareId

GET    /health
WS     /ws                      presence, see below
```
Errors: `{ "error": { "code", "message" } }`. 400 validation, 401 no/invalid token, 403 role too low,
404 not found or not visible, 409 version conflict, 428 missing If-Match.

## Concurrency
Every note has a `version`. `GET` returns it as an ETag. `PATCH` must send `If-Match`. The update is
`UPDATE ... WHERE id = $1 AND version = $2`, which bumps the version. Zero rows updated means 409, and
the response includes the current note so the client can merge. Two editors can't silently overwrite each other.

## Search
One box: the client sends `GET /notes?q=<text>` and gets ranked results, each with a highlighted
snippet. No tags. Search covers title, body and checklist text, and it only searches notes the caller
can read (same access CTE, same query).

- **Full-text:** the generated `search` tsvector with a GIN index, so stemming works ("meeting"
  matches "meetings") and title hits rank above body hits. Each word of the query becomes a prefix
  match (`plan:*`), so results show up while the user is still typing.
- **Fuzzy:** `pg_trgm` trigram similarity on the title catches typos and partial words that full-text misses.
- **Ranking:** `ts_rank` plus title similarity. `ts_headline` produces the snippet.
- With no `q`, results sort by `updated_at` desc.

It all runs inside Postgres: no extra service to run or keep in sync. Semantic (embedding) search with
pgvector is the natural next step for vague, meaning-based queries, as a hybrid with this one.

## Presence and cursors
A WebSocket at `/ws`. The client authenticates with the same JWT on connect, then joins notes.
```
client -> { type: "join",   noteId }
client -> { type: "leave",  noteId }
client -> { type: "cursor", noteId, field: "title"|"body"|"item:<id>", anchor, head }
client -> { type: "activity", noteId, mode: "viewing"|"editing" }
server -> { type: "presence", noteId, users: [{ userId, displayName, mode, cursor? }] }
server -> { type: "note.updated", noteId, version, updatedBy }
server -> { type: "error", code, message }
```
- `join` requires read access, and `mode: "editing"` requires the editor role (same access check as REST).
- Presence is in memory, per process. A connection that sends nothing for 30s gets dropped
  (ping/pong). Running more than one process would need Redis pub/sub; noted, not built.
- When a REST `PATCH` succeeds, the server sends `note.updated` to everyone in that note's room, so viewers know to refetch.
- **Limit:** cursors are relayed live, but content syncs only through REST saves. A remote cursor can
  drift until the next save. Real Google-Docs co-editing needs a CRDT (Yjs), which is out of scope.
- No frontend ships. The tests drive this with two WebSocket clients, plus a small demo script in `scripts/`.

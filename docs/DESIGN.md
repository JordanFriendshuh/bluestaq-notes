# Design

## Scope
**In:** accounts and auth, teams, notes with optional checklists, sharing notes with users or teams
as viewer or editor, search-as-you-type, an MCP endpoint so AI clients can use the same features,
optimistic concurrency, live presence and cursors.

**Out (README "more time" list):** attachments (S3 + presigned URLs), real-time co-editing of content
(CRDT/Yjs), organizations/tenancy, refresh tokens, notebooks as a shared unit, OAuth for MCP clients,
server-side semantic search (embeddings).

## Data model (PostgreSQL)
```
users        id uuid pk, email citext unique, display_name, password_hash, created_at
teams        id uuid pk, name, created_by -> users, created_at
team_members team_id -> teams, user_id -> users, role ('owner'|'member'), pk(team_id, user_id)
notes        id uuid pk, owner_id -> users, title, body,
             version int default 1, created_at, updated_at,
             search tsvector generated (title weight A, body B)
note_items   id uuid pk, note_id -> notes on delete cascade, text, done bool,
             position text collate "C", version int default 1, created_at, updated_at,
             unique (note_id, position)
note_shares  id uuid pk, note_id -> notes on delete cascade,
             user_id -> users null, team_id -> teams null,
             role ('viewer'|'editor'), created_at,
             check (exactly one of user_id, team_id), unique per (note, user) and (note, team)
```
- **Checklist items are rows, each with its own URL.** A note can be prose, a list, or both. Every note
  response embeds its items in order as `items: [{ id, text, done }]`. Items change one at a time
  through `/notes/:id/items/:itemId`, so two people ticking different items never collide. Replacing
  the whole list on every change would make every concurrent edit a conflict. Up to 500 items per note,
  one-line text of 1–500 characters.
- **Order uses fractional indexing** (`fractional-indexing`). Each item's `position` is a key that sorts
  between its neighbors, so adding or moving an item writes only that row. Clients never see keys; they
  send `after: <itemId>` (null for the top, omitted for the bottom). Keys sort by byte, hence `COLLATE "C"`.
- **Item writes lock the note row** (the `updated_at` bump does it), so two inserts at the same spot
  can't pick the same key. The lock is per note and held for one short transaction.
- **Shares use two nullable foreign keys, not a polymorphic `principal_id`**, so Postgres enforces
  referential integrity and deleting a user or team cleans up its grants.
- **Effective role** = owner if `owner_id` matches, otherwise the highest role across the caller's direct
  grant and the grants of every team they belong to. One SQL function/CTE computes it (`notes/access.ts`).

## Auth
- Email + password. Passwords are hashed with bcrypt (cost 12, configurable). They're limited to 72
  *bytes*, because bcrypt silently ignores anything past that.
- Login returns an HS256 JWT (`sub` = user id) that lasts 1 hour. Verification pins the algorithm
  (so `alg: none` and algorithm-swap tokens get rejected), checks issuer and audience, and requires
  `sub` to be a UUID. The `Bearer` scheme name is case-insensitive.
- The signing key is never in the repo. Compose generates a random one into `./secrets` and passes
  it as `JWT_SECRET_FILE`.
- Register and login share a per-IP rate limit (20 per 15 minutes by default, then 429 `rate_limited`).
  It slows password guessing and caps how much bcrypt CPU one client can burn. Behind a
  TLS-terminating proxy, the app trusts one `X-Forwarded-For` hop so each client gets its own limit.
- Unknown email and wrong password return the same 401 and take the same time (a dummy hash at the
  configured cost gets compared), so login can't be used to find out which emails have accounts.
  Registration does reveal it (409 `email_taken`). That's the usual tradeoff for a clear signup error;
  the rate limit caps how fast anyone can probe it.
- Emails are `citext`: unique and matched without regard to case.
- Not built (README "more time" list): refresh tokens and revocation, per-account lockout, a shared
  rate-limit store (Redis) for multiple instances, email verification.

## Data protection
- **In transit: TLS everywhere, including the local demo.**
  - Clients reach the API over HTTPS (TLS 1.2+), and presence uses `wss://`.
  - The API connects to Postgres with certificate *and* hostname verification. Postgres's `pg_hba`
    rejects any TCP connection that isn't TLS.
  - Compose creates a private CA on first start. A real deployment supplies its own certificates,
    or sets `TLS_TERMINATED_UPSTREAM=true` behind a TLS-terminating load balancer.
  - In production, config refuses to start with plain HTTP or `DATABASE_TLS=off`.
- **At rest: we recommend disk or volume encryption for the deployed database** (managed-database
  encryption, encrypted EBS, or LUKS). It covers data files, WAL and backups with no code changes.
  Managed services (RDS, MongoDB Atlas) do the same.
- **Why not column-level encryption:** Postgres can't run full-text search or trigram matching on
  ciphertext, so encrypting note content in the database would disable search. Fields
  that never need to be searched could be encrypted in the app with KMS-managed keys if a future
  requirement calls for it.
- **Passwords** are bcrypt hashes. They're never stored or logged, and can't be reversed.

## Input hygiene
- Every body goes through zod. Unknown fields are dropped, so `id`, `passwordHash` and similar can't
  be set by clients, and `__proto__` keys never reach our objects.
- One-line text (names, titles) rejects control characters. That covers NUL (which Postgres can't
  store, so it used to become a 500), newlines (log/header injection) and terminal escape sequences.
- Multi-line text (note bodies) keeps newlines and tabs but rejects every other control character.
  Titles are 1–200 characters and bodies up to 50,000.
- JSON only, 256 KB max (413 above that), and helmet's security headers (HSTS, nosniff, frame options)
  on every response, error responses included.

## Permissions
| Action                      | Owner | Editor | Viewer |
|-----------------------------|:-----:|:------:|:------:|
| Read note                   | ✓     | ✓      | ✓      |
| Edit title, body, items     | ✓     | ✓      |        |
| Delete note                 | ✓     |        |        |
| Add or remove shares        | ✓     |        |        |

Teams: anyone can create one and becomes its owner. Owners add existing users by email (as `member`
or `owner`), remove anyone, and delete the team. Members can see the team and its member list, and can leave.
- Deleting a team removes its memberships and every note share granted to it (foreign-key cascade).
  The notes themselves stay with their owners.
- A team always keeps at least one owner (409 `last_owner`). Removal locks the team row, so two owners
  removing each other at the same moment can't leave it ownerless.
- A team the caller isn't on is a 404, the same as for notes. Adding an unknown email is 404
  `user_not_found`, and adding someone already on the team is 409 `already_member`.

## API
All JSON. Auth is `Authorization: Bearer <jwt>` everywhere except register, login and health.
```
POST   /auth/register           { email, password, displayName } -> { token, user }
POST   /auth/login              { email, password } -> { token, user }
GET    /me

POST   /teams                   GET /teams          GET /teams/:id      DELETE /teams/:id
POST   /teams/:id/members       { email, role }
DELETE /teams/:id/members/:userId

POST   /notes                   { title, body?, items?: [{ text, done? }] }
GET    /notes                   ?q=&scope=all|owned|shared&limit=&offset=
GET    /notes/:id               -> ETag: "<version>"
PATCH  /notes/:id               If-Match required; partial { title?, body? }
DELETE /notes/:id

POST   /notes/:id/items         { text, done?, after? }
PATCH  /notes/:id/items/:itemId If-Match required; partial { text?, done?, after? }
DELETE /notes/:id/items/:itemId

GET    /notes/:id/shares
PUT    /notes/:id/shares        { userEmail | teamId, role }  (upsert)
DELETE /notes/:id/shares/:shareId

GET    /health
POST   /mcp                     MCP (Streamable HTTP), see below
WS     /ws                      presence, see below
```
Errors: `{ "error": { "code", "message", "details"? } }`. `details` is only on validation errors:
one `{ path, message }` per invalid field (for example `path: "items.0.text"`). 400 validation, 401 no/invalid token, 403 role too low,
404 not found or not visible, 409 version conflict or full checklist, 428 missing If-Match.

## Concurrency
Every note has a `version`. `GET` returns it as an ETag. `PATCH` must send `If-Match`. The update is
`UPDATE ... WHERE id = $1 AND version = $2`, which bumps the version. Zero rows updated means 409, and
the response includes the current note so the client can merge. Two editors can't silently overwrite each other.

The note's version covers its title and body only. Each checklist item has its own version and
`If-Match`, so ticking an item never invalidates someone's pending edit to the note text.

## Search
One search box, no tags: fast, ranked, typo-tolerant search on every keystroke (`GET /notes?q=`).
It searches title, body and checklist item text (a join on `note_items` with its own index), only returns notes the caller can read (same access CTE
in the same query), and each result comes with a highlighted snippet.

- **Full-text:** the generated `search` tsvector with a GIN index, so stemming works ("meeting"
  matches "meetings") and title hits rank above body hits. Each word of the query becomes a prefix
  match (`plan:*`), so results show up while the user is still typing.
- **Fuzzy:** `pg_trgm` trigram similarity on the title catches typos and partial words that full-text misses.
- **Ranking:** `ts_rank` plus title similarity. `ts_headline` produces the snippet.
- With no `q`, results sort by `updated_at` desc.

It all runs inside Postgres: no extra service to run or keep in sync. Search by meaning comes from
AI clients over MCP (below), not from a model inside the service.

## MCP
`POST /mcp` exposes the API to AI clients (Claude, Claude Code, Cursor) over the Model Context
Protocol, using the official SDK (`@modelcontextprotocol/sdk`) and its Streamable HTTP transport.
The client reads the tool list, decides when to call a tool, and gets JSON back.

```
list_teams      {}                                   -> teams the caller belongs to
search_notes    { q?, scope?, limit? }               -> same results as GET /notes
get_note        { noteId }                           -> note with its version
create_note     { title, body?, items? }
update_note     { noteId, version, title?, body? }
add_item        { noteId, text, after? }
update_item     { noteId, itemId, version, text?, done?, after? }
delete_item     { noteId, itemId }
share_note      { noteId, userEmail | teamId, role }
```
- **Tools are thin wrappers over the same services as REST.** Input goes through the same zod
  schemas, and every note goes through `notes/access.ts`, so MCP can never see or do more than REST.
- **Semantic search happens in the client.** The model turns a vague question into several keyword
  searches with `search_notes` and reads the hits. No embeddings, no model in the service, no API key.
- **Auth:** the same `Authorization: Bearer <jwt>` as REST (`claude mcp add --transport http notes
  https://localhost:3000/mcp --header "Authorization: Bearer <jwt>"`). The MCP spec's answer for
  remote servers is OAuth 2.1; that's on the "more time" list.
- **Stateless:** each request builds its server from the caller's token, with no MCP sessions to keep.
- **Errors** are tool results with `isError: true` and the same `code` and `message` as REST.
  `update_note` needs `version`, so a stale write is a `version_conflict` with the current note.
- Tests call each tool over HTTP and repeat the permission matrix for MCP (owner, editor, viewer,
  team member, stranger).

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

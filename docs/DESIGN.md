# Design

## Scope
**In:** accounts and auth, teams, notes with optional checklists, sharing notes with users or teams
as viewer or editor, search-as-you-type, AI (semantic) search with a local embedding model,
optimistic concurrency, live presence and cursors.

**Out (README "more time" list):** attachments (S3 + presigned URLs), real-time co-editing of content
(CRDT/Yjs), organizations/tenancy, refresh tokens, notebooks as a shared unit.

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
note_embeddings  note_id pk -> notes on delete cascade, model, content_hash,
                 embedding vector(384), updated_at
```
- **Checklists live inside the note** as `items: [{ id, text, done }]`. A note can be prose, a list, or both.
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
- **Why not column-level encryption:** Postgres can't run full-text search, trigram matching or
  embeddings on ciphertext, so encrypting note content in the database would disable search. Fields
  that never need to be searched could be encrypted in the app with KMS-managed keys if a future
  requirement calls for it.
- **Passwords** are bcrypt hashes. They're never stored or logged, and can't be reversed.

## Input hygiene
- Every body goes through zod. Unknown fields are dropped, so `id`, `passwordHash` and similar can't
  be set by clients, and `__proto__` keys never reach our objects.
- One-line text (names, titles) rejects control characters. That covers NUL (which Postgres can't
  store, so it used to become a 500), newlines (log/header injection) and terminal escape sequences.
- JSON only, 256 KB max (413 above that), and helmet's security headers (HSTS, nosniff, frame options)
  on every response, error responses included.

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
GET    /notes/search/ai         ?q=&limit=   (503 ai_search_disabled when AI_SEARCH=off)
GET    /notes/:id               -> ETag: "<version>"
PATCH  /notes/:id               If-Match required; partial { title?, body?, items? }
DELETE /notes/:id

GET    /notes/:id/shares
PUT    /notes/:id/shares        { userEmail | teamId, role }  (upsert)
DELETE /notes/:id/shares/:shareId

GET    /health
WS     /ws                      presence, see below
```
Errors: `{ "error": { "code", "message", "details"? } }`. `details` is only on validation errors:
one `{ path, message }` per invalid field (for example `path: "items.0.text"`). 400 validation, 401 no/invalid token, 403 role too low,
404 not found or not visible, 409 version conflict, 428 missing If-Match.

## Concurrency
Every note has a `version`. `GET` returns it as an ETag. `PATCH` must send `If-Match`. The update is
`UPDATE ... WHERE id = $1 AND version = $2`, which bumps the version. Zero rows updated means 409, and
the response includes the current note so the client can merge. Two editors can't silently overwrite each other.

## Search
Two steps from one search box. No tags.

1. **As you type:** fast, ranked, typo-tolerant search on every keystroke (`GET /notes?q=`).
2. **AI search:** if the user doesn't find the note, they ask for AI search (`GET /notes/search/ai?q=`),
   which matches by meaning, not wording. It runs on an embedding model inside the service.

Both search title, body and checklist text, and both only return notes the caller can read (same
access CTE in the same query). Each result comes with a highlighted snippet.

### As you type

- **Full-text:** the generated `search` tsvector with a GIN index, so stemming works ("meeting"
  matches "meetings") and title hits rank above body hits. Each word of the query becomes a prefix
  match (`plan:*`), so results show up while the user is still typing.
- **Fuzzy:** `pg_trgm` trigram similarity on the title catches typos and partial words that full-text misses.
- **Ranking:** `ts_rank` plus title similarity. `ts_headline` produces the snippet.
- With no `q`, results sort by `updated_at` desc.

It all runs inside Postgres: no extra service to run or keep in sync.

### AI search
- **A local embedding model, no API key.** `bge-small-en-v1.5` (384 dimensions, about 35 MB quantized)
  runs in-process with `@huggingface/transformers` (ONNX on the CPU). Note text never leaves the server,
  and the feature costs nothing.
- **The model is baked into the Docker image** at build time, so the first search is fast and the
  service runs offline. The tradeoff is a bigger image and some CPU used per save.
- **Embedding with pgvector.** When a note is created or updated, its title, body and items are embedded
  *after* the response is sent, so a save never waits on the model. `content_hash` skips the work when
  the text hasn't changed. On startup, notes with no embedding or a stale one get backfilled.
- **Query:** embed the query (with bge's query prefix), then a nearest-neighbor search (cosine distance)
  over the caller's readable notes.
- **The embedder sits behind a small interface** (`embed(texts) -> vectors`). Tests use a deterministic
  fake, and a hosted provider could be swapped in with one file.
- `AI_SEARCH=off` turns it off for low-resource deployments. The endpoint then returns 503 `ai_search_disabled`.
- The Postgres image is `pgvector/pgvector:pg16`.

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

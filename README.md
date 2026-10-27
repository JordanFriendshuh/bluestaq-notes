# Team Notes API

A backend for notes shared among small teams. People write notes with optional checklists, share
them with other people or whole teams as viewers or editors, find them with search-as-you-type, and
see each other's edits and cursors live. AI assistants such as Claude can use the same API through
MCP.

Node 22, TypeScript, Express 5, PostgreSQL 16. Bluestaq backend coding challenge.

- **[docs/DESIGN.md](docs/DESIGN.md)**: data model, every endpoint, the permission rules, concurrency,
  search, MCP, WebSocket protocol and query performance.
- **[docs/BUILT-WITH-CLAUDE.md](docs/BUILT-WITH-CLAUDE.md)**: how this was built with Claude Code.

## Run it

```sh
docker compose up --build
curl --cacert secrets/ca.crt https://localhost:3000/health
```

Everything runs over TLS, even locally. On first start a one-shot `secrets` container writes the
stack's secrets to `./secrets` (gitignored): a private CA, certificates for Postgres and the API, and
a random JWT signing key. The repo ships no secrets. Trust `secrets/ca.crt` (or pass `-k` to curl).
Plain HTTP is refused, and so are database connections without TLS.

The API listens on 3000 and Postgres on 5432, both bound to localhost only. If those ports are
taken, override them with `API_PORT` / `DB_PORT`. Migrations run automatically on startup. To
regenerate the secrets, delete everything in `./secrets` except `.gitkeep` and start again.

### Try it

```sh
api() { curl -s --cacert secrets/ca.crt -H 'Content-Type: application/json' "$@"; }

TOKEN=$(api https://localhost:3000/auth/register \
  -d '{"email":"ada@example.com","password":"correct horse battery","displayName":"Ada"}' \
  | sed -E 's/.*"token":"([^"]+)".*/\1/')
AUTH="Authorization: Bearer $TOKEN"

api -H "$AUTH" https://localhost:3000/notes \
  -d '{"title":"Weekly planning","body":"Roadmap and budget review","items":[{"text":"Draft agenda"}]}'

api -H "$AUTH" 'https://localhost:3000/notes?q=budg'    # search as you type
```

Updates need the version you last read: `PATCH /notes/:id` with `If-Match: "1"`. A stale version
gets a 409 that includes the current note.

### Or click around

Open https://localhost:3000/playground/ for a small browser client (plain HTML and JavaScript in
`playground/`, served by the API). It covers sign-in, search, notes, checklists, sharing, teams, and
live presence. Sign in as different users in two tabs and open the same note to watch presence and
live edits. Your browser will warn about the local certificate; trust `secrets/ca.crt` or proceed.

### Use it from Claude Code (MCP)

```sh
claude mcp add --transport http notes https://localhost:3000/mcp \
  --header "Authorization: Bearer $TOKEN"
NODE_EXTRA_CA_CERTS=secrets/ca.crt claude
```

Claude then has nine tools: listing teams, searching, reading, creating and editing notes and
checklist items, and sharing. They act as the token's user, with the same permissions as REST.

## What it does

| Area | Endpoints |
|---|---|
| Accounts | `POST /auth/register`, `POST /auth/login`, `GET /me` |
| Teams | create, list, view, delete; owners add and remove members by email |
| Notes | create, list, get, update, delete; `GET /notes?q=` searches, `scope=owned\|shared` filters |
| Checklists | `POST /notes/:id/items`; tick, rename, move or delete one item at a time |
| Sharing | grant a user or a team `viewer` or `editor`; change or revoke it |
| Live | WebSocket at `/ws`: who's viewing or editing, their cursors, every change as it happens |
| AI | MCP at `POST /mcp` |

Full request and response shapes are in [docs/DESIGN.md](docs/DESIGN.md#api).

## Develop and test

Requires Node 22 (`nvm use`) and Docker.

```sh
npm install
docker compose up -d db     # Postgres with TLS (creates ./secrets) and the notes_test database
npm test
npm run dev                 # with the variables from .env.example
npm run lint && npm run typecheck
npm run perf:explain        # EXPLAIN ANALYZE every service query at realistic volume
```

292 tests run against a real Postgres (`notes_test`, or `TEST_DATABASE_URL`) over verified TLS, so
SQL, constraints, extensions and the transport all get exercised for real. The reset helper refuses
to truncate any database whose name doesn't end in `_test`. Permission rules are tested for every
role: owner, editor, viewer, team member and stranger, over REST, WebSocket and MCP.

`test/security/` holds the attack suite: forged and tampered tokens, SQL and tsquery injection, mass
assignment, prototype pollution, hostile strings, brute force, signup races, security headers,
cross-user access, WebSocket abuse (oversized frames, floods, slow readers, races with revocation)
and the MCP transport. Every security fix has a test there that fails on the code before the fix.

## The design choices we spent the most time on

**1. One definition of access, enforced everywhere, including live connections.** A user's role on
a note is owner, or the highest of their direct grant and the grants of every team they're on. One
query builder in `src/notes/access.ts` decides it. REST, search, the WebSocket and MCP all use it, so
there's nothing to keep in sync. A note you can't read is a 404, never a 403, so its existence
doesn't leak. Access is checked again when it changes: unsharing a note, removing someone from a
team or deleting a team removes affected people from the note's live room right away. The SQL review
then rewrote that query from `OR EXISTS` into a union of three index lookups, which took the notes
list from 224 ms to 3 ms at 50,000 notes.

**2. Checklist items are rows, ordered by fractional index, each with its own version.** The first
version stored the checklist as a JSON array that each save replaced whole. That's simple, but two
people ticking different boxes at the same moment would collide. Each item now has its own row, URL
and version. Order is kept with fractional indexing, so adding or moving an item rewrites only that
item. Every note and every item has a version. Updates must send `If-Match`, and a stale write gets
a 409 with the current copy instead of silently overwriting. The note's version covers its title and
body only, so ticking an item never invalidates someone's pending text edit. Changes are pushed to
everyone viewing the note over the WebSocket, so most conflicts never happen.

**3. Search lives in Postgres, and AI goes through MCP instead of a model in the service.** Search
runs inside Postgres: each text is indexed both as typed and stemmed, so "meetin" finds "meeting"
while you type and "meetings" finds it too. Typos in titles are caught with trigram similarity, and
snippets come back as plain-text parts, never HTML. The plan was to add semantic search with an
embedding model inside the service. We replaced it with an MCP endpoint: an AI client turns a vague
question into several keyword searches and reads the results. That's less to run and secure, and it
adds a capability (an assistant can edit and share notes, not just find them) with no model or API key on
the server.

## With more time

**Add**
- OAuth 2.1 for MCP clients; today they send the same bearer token as REST.
- Refresh tokens and revocation, per-account lockout, and email verification.
- Redis pub/sub behind the event bus, so live updates work across more than one process.
- Character-level co-editing of note bodies (Yjs). Today cursors are live and text syncs on save.
- Attachments in S3 with presigned URLs. They were in the original scope and cut early.
- Rate limits on the two routes that reveal whether an email has an account (sharing and adding team
  members by email), like registration already has.

**Change**
- Keyset pagination instead of `OFFSET`, and drive search from its GIN indexes once a user can read
  tens of thousands of notes. Both are fine at team scale (measured in DESIGN.md).

**Stop**
- Running migrations on application startup. That's fine for one instance; with several, run them
  once as a deploy step.

## Built with AI

Built with Claude Code as a pair programmer: I set the design and conventions, decided every
tradeoff, and reviewed and merged each change as its own PR. The process is described in
[docs/BUILT-WITH-CLAUDE.md](docs/BUILT-WITH-CLAUDE.md).

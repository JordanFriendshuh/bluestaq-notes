# Team Notes API

Backend for a note-taking service shared among several small teams. This is a take-home coding
challenge for Bluestaq: a runnable REST service, tests, and a README. Reviewers judge **clarity,
correctness and tradeoffs**, so a smaller scope done well beats a wide one done thin.

The design (data model, endpoints, search, MCP, presence) is in `docs/DESIGN.md`. Read it before you
change behavior, and update it in the same PR when behavior changes.

## Stack
- Node 22 (`.nvmrc`), TypeScript (strict), Express 5
- PostgreSQL 16 with pg_trgm, plain SQL migrations in `migrations/`, Kysely for typed queries
- MCP: `@modelcontextprotocol/sdk` on `POST /mcp` (Streamable HTTP, stateless). Tools wrap the services;
  they never hold their own logic or SQL.
- zod validates every request body, query and param at the route boundary
- Auth: bcryptjs password hashes, JWT bearer tokens (jsonwebtoken)
- Presence: `ws` WebSocket server on the same HTTP server
- Tests: vitest + supertest against a real Postgres (the test database from docker compose)
- `docker compose up` must start the whole service with no other setup. The reviewer runs it that way.

## Layout
```
src/
  app.ts            express app wiring (no listen), used by server.ts and the tests
  server.ts         starts HTTP + WebSocket
  config.ts         env parsing (zod), the only place that reads process.env
  db/               kysely instance, generated table types
  auth/  teams/  notes/  shares/  search/  mcp/  presence/
                    one folder per feature: routes.ts, service.ts, schemas.ts
  middleware/       auth, error handler, validation
migrations/         numbered .sql files, forward only
test/               mirrors src/ by feature
docs/DESIGN.md
```
Routes parse input and shape output. Services hold the logic and the SQL. Routes never query the database directly.

## Code style
- **Comments are 1–2 lines.** Write them only on function headers, and inside a body only where the
  behavior is unusual and the code can't show why on its own.
- **Never write comments about history or past decisions** ("changed from X", "we used to", "per review").
  That belongs in commit messages and PRs.
- Names do the explaining: a function name says what it does, and a variable says what it holds.
- Small functions, early returns, no clever one-liners.
- Errors: throw `HttpError(status, code, message)`. The error middleware turns it into
  `{ "error": { "code": "...", "message": "..." } }`. Never leak stack traces or SQL errors.
- No `any`. Database row types come from `src/db/types.ts`.

## Rules that hold everywhere
- REST routes and MCP tools are two front doors to the same services. A feature added to one gets
  added to the other in the same PR, with the same permission tests.
- Every note query goes through the access check in `notes/access.ts`. Never hand-write
  "can this user see this note" logic anywhere else.
- A note the caller can't read returns **404**, never 403, so its existence doesn't leak. 403 means
  the caller can read the note but lacks the role for this action.
- Note updates require `If-Match: <version>` (428 if missing, 409 on mismatch).
- Passwords and tokens never appear in logs or responses.
- One-line user text uses `singleLineText()` from `src/http/text.ts`. Never use a bare `z.string()` for
  something a person types in.
- Every security fix ships with a test in `test/security/` that fails on the old code.

## Workflow
- Jordan reviews every change as a PR. Work on a branch (`feat/…`, `fix/…`, `docs/…`), open a PR with
  `gh pr create`, and stop. **Never push to `main`, never merge.**
- Branch from `main` and target `main`. Avoid stacked PRs. If one is unavoidable, retarget it to
  `main` after its base merges and *before* merging it.
- One concern per PR, small enough to review in one sitting. The PR description says what changed,
  why, and how it was tested.
- Commits are small and real, with imperative subject lines. The commit history is part of the
  submission.
- Before opening a PR: `npm run lint`, `npm run typecheck`, `npm test` all pass. Say in the PR if anything was skipped.
- New behavior ships with tests. Permission rules get tests for every role: owner, editor, viewer,
  team member, stranger.

## README requirements (from the challenge)
The final README must have: how to run it and run the tests, the 2–3 design choices we spent the most
time on and why, what we'd change, add or stop doing with more time, and a short, plain note that it
was built with AI assistance.

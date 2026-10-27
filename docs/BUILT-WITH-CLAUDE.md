# How I built this with Claude

I built this service with Claude Code the way I'd run a small team: I owned the design and the
decisions, Claude did most of the typing, and nothing reached `main` without a pull request I had
read. This page describes that process, because how I used the tool matters as much as what it
produced.

It took about five hours of working time over two sessions. The result is 18 pull requests, about 75
commits, and 292 tests that run against a real Postgres.

## 1. Definitions before code

The first instruction was not "build a notes API". It was to write the project's rules and design
and stop:

> "The first thing is to build the auth system, but don't build right away. Let's just make sure we
> get our MDs and definitions correct first."

That produced two files that steered everything after them:

- **[`CLAUDE.md`](../CLAUDE.md)**: the contract Claude reads at the start of every session. It sets
  the stack, the folder layout, the code style ("comments are 1–2 lines, only on function headers or
  non-obvious behavior, never about past decisions"), rules that must hold everywhere (every note
  query goes through one access check; a note you can't read is a 404, never a 403; every security
  fix ships with a test that fails on the old code), and the workflow.
- **[`docs/DESIGN.md`](DESIGN.md)**: the data model, endpoints, permissions and protocols. Every PR
  that changes behavior updates it in the same PR, so the design always describes the code as it is.

The design was reviewed and merged as PR #1 before any code existed.

## 2. One small PR per step, and I review every one

Claude works on a branch, opens a PR with a description of what changed, why, and how it was
tested, then stops. It never merges on its own; the two times it did (#1 and #7), it was because I
told it to after reviewing the change in our conversation. Each PR is one concern I can read in a
single sitting:

| PRs | Step |
|---|---|
| #1 | Conventions and design, no code |
| #2–#6 | Scaffold, auth, TLS everywhere, then a security review with an attack test suite |
| #7 | Design change: MCP instead of a built-in AI search model |
| #8–#9 | Teams; a reminder to review SQL efficiency before submission |
| #10–#12 | Notes split into three: plain REST, then checklists, then version checks |
| #13–#14 | Live presence over WebSocket (with its own security review), then sharing |
| #15 | A workflow rule for PR descriptions |
| #16–#18 | Search, the MCP endpoint, and the SQL efficiency review |

I split work where a combined PR would have been too big to review properly. Notes became three PRs
because checklists and concurrency each deserved their own discussion. When an early PR that was
stacked on another got merged into the stale branch instead of `main` (#4), Claude caught it, carried
the same reviewed commits into `main` (#5), and added "avoid stacked PRs" to `CLAUDE.md`. Since then,
work branches from `main`. The one time a dependency was real (WebSocket events needed the version
numbers from #12), the PR said "merge #12 first".

## 3. Real back-and-forth on the design

I used Claude to pressure-test my ideas, not to replace them. Some of the decisions that changed
along the way:

- **MongoDB → PostgreSQL.** I started with MongoDB for flexible note documents. Talking it through,
  users, teams and shares are relational, and that's where the hard rules live, so Postgres won.
- **Tags → search.** What I actually wanted from tags was finding a note fast, so tags became
  search-as-you-type.
- **AI search → MCP.** I first planned AI search with an API key, then with a local embedding model.
  Before building it, I replaced it with an MCP endpoint: an AI client can do the "search by meaning"
  part itself by running keyword searches, and it can also edit and share notes. Less to run, less to
  secure, more capability.
- **Checklists: whole list → one row per item.** The first checklist PR replaced the whole list on
  every save. Reviewing it, I asked whether that was the standard design and what happens when two
  people work on one list. We went through the standard options (sub-resource rows, patch
  operations, CRDTs) and how ordering is usually solved (fractional indexing), and I had the PR
  reworked so each item has its own row, URL and version.
- **Concurrency, explained before built.** I asked how tools like Office keep people in sync. We
  agreed on three levels: version checks so no edit is silently lost, a WebSocket that pushes changes
  live, and character-level co-editing, which I left out of scope and listed under "more time".
- **Security posture.** I asked about encryption at rest. The decision was TLS on every connection,
  including the local demo and the database, plus disk encryption for the deployed database. Column
  encryption was rejected because it would break search, and that tradeoff is written down.

I also added scope as I reviewed. For example, I asked for owners to be able to delete teams while
the teams PR was still open, and it went into that PR.

## 4. Verify, don't trust

AI-written code is confident whether or not it's right, so I built checking into the process instead
of relying on reading alone.

- **Security reviews at checkpoints.** I asked for a dedicated security pass after auth (#6), before
  merging the WebSocket work, and before merging sharing. The WebSocket review found that a single
  oversized message, sent before logging in, could crash the server process, plus missing rate and
  backlog limits. The sharing review found a team-membership change that made the server re-check
  every connected user's access (an amplification an attacker could loop), and a race where a
  revoked user could slip into a live room. All were fixed before merge, each with a test.
- **Tests that prove they can fail.** For every fix that guards against a race or an attack, Claude
  ran the test against the code without the fix to confirm it fails, and reported that. Where a test
  couldn't fail, it was rewritten until it could. The join-versus-revocation race, for example, is
  now made deterministic by delaying database results in the test.
- **Measure instead of guess.** The SQL review generated realistic volume (50,000 notes, ~270,000
  checklist items, ~60,000 shares), ran the real service code against it, and explained every query
  it sent. It found that the access check scanned every note and that Postgres's JIT and parallel
  workers cost more than the queries themselves: 224 ms → 3 ms for the notes list. The script is
  committed (`npm run perf:explain`) so anyone can repeat it.
- **Run the real thing.** Beyond the tests, the Docker image was built and called over HTTPS, and
  Claude Code itself was connected to the MCP endpoint to create and find a note.

## 5. Rules for working with the AI

Some instructions are about how Claude works, not what it builds. They're written into `CLAUDE.md`
so they hold in every session:

- Work on a branch, open a PR, and stop. Never push to `main`.
- Keep comments short and about the code as it is; history belongs in commits and PRs.
- REST and MCP are two front doors to the same services, and any new feature gets both, with the
  same permission tests.
- PR descriptions describe the change and how it's tested. They mention bugs only if the bug existed
  before the PR started, not mistakes made and fixed while building it.

## What I'd take from this

The speed came from Claude. The quality came from the structure around it: definitions agreed before
code, small PRs I could actually review, design decisions argued out and recorded, and verification
I didn't have to take on faith. That's the same structure I'd want from a team of engineers, and it's
how I'd use AI on a real codebase.

# Team Notes API

REST backend for a note-taking service shared among small teams. Bluestaq backend coding challenge.
The design is in [docs/DESIGN.md](docs/DESIGN.md).

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

## Develop and test

Requires Node 22 (`nvm use`) and Docker.

```sh
npm install
docker compose up -d db     # Postgres with TLS (creates ./secrets) and the notes_test database
npm test
npm run dev                 # with the variables from .env.example
npm run lint && npm run typecheck
```

Tests run against a real Postgres (`notes_test`, or `TEST_DATABASE_URL`) over verified TLS, so SQL,
constraints, extensions and the transport all get exercised for real. The reset helper refuses to
truncate any database whose name doesn't end in `_test`.

`test/security/` holds the attack suite: forged and tampered tokens, SQL injection, mass assignment,
prototype pollution, hostile strings, malformed bodies, brute force, signup races and security headers.

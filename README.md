# Team Notes API

REST backend for a note-taking service shared among small teams. Bluestaq backend coding challenge.
The design is in [docs/DESIGN.md](docs/DESIGN.md).

## Run it

```sh
docker compose up --build
curl --cacert certs/ca.crt https://localhost:3000/health
```

Everything runs over TLS, even locally. On first start a one-shot `certs` container creates a
private CA in `./certs`, then signs certificates for Postgres and the API. Trust `certs/ca.crt` (or
pass `-k` to curl). Plain HTTP is refused, and so are database connections without TLS.

The API listens on 3000 and Postgres on 5432. If those ports are taken, override them with
`API_PORT` / `DB_PORT`. Migrations run automatically on startup. To regenerate the certificates,
delete everything in `./certs` except `.gitkeep` and start again.

## Develop and test

Requires Node 22 (`nvm use`) and Docker.

```sh
npm install
docker compose up -d db     # Postgres with TLS (creates ./certs) and the notes_test database
npm test
npm run dev                 # with the variables from .env.example
npm run lint && npm run typecheck
```

Tests run against a real Postgres (`notes_test`, or `TEST_DATABASE_URL`) over verified TLS, so SQL,
constraints, extensions and the transport all get exercised for real.

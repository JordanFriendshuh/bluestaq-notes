# Team Notes API

REST backend for a note-taking service shared among small teams. Bluestaq backend coding challenge.
The design is in [docs/DESIGN.md](docs/DESIGN.md).

## Run it

```sh
docker compose up --build
curl localhost:3000/health
```

The API listens on port 3000 and Postgres on 5432. If those ports are taken, override them with
`API_PORT` / `DB_PORT`. Migrations run automatically on startup.

## Develop and test

Requires Node 22 (`nvm use`) and Docker.

```sh
npm install
docker compose up -d db     # Postgres, including the notes_test database
npm test
npm run dev                 # with DATABASE_URL from .env.example
npm run lint && npm run typecheck
```

Tests run against a real Postgres (`notes_test`, or `TEST_DATABASE_URL`), so SQL, constraints and
extensions get exercised for real.

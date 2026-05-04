# Hindsight

Internal screenshot-based time tracking for small teams. Members install a desktop app, pick a project, and start a timer. While tracking, the app captures periodic screenshots and aggregate activity metrics, then uploads them to a server. Managers and members both view their data through the same web app, scoped by role.

> **Status:** Pre-development. Architecture and product decisions live in [`/docs`](./docs). Code starts after the docs are signed off.

---

## What's in this repo

```
hindsight/
├── apps/
│   ├── api/         # Fastify + TypeScript backend (REST, workers, presigning)
│   ├── web/         # React + Vite SPA — admin and member portals
│   └── desktop/     # Tauri 2 app (Win/Mac) — screenshot capture, outbox
├── packages/
│   └── shared/      # Zod schemas, TS types, capability matrix shared across apps
├── docs/            # Source of truth for product + architecture decisions
├── docker-compose.yml
└── README.md
```

The monorepo uses **pnpm workspaces**. Apps are independent — you can run any one without the others, given a working API.

## Read the docs first

If you're new to the project (human or LLM), read [`docs/README.md`](./docs/README.md) and follow its read order. The `/docs` folder is the source of truth — code drift is fixed by updating code, doc drift is fixed by updating docs.

Quick links:

- [Overview](./docs/01-overview.md) — what the product does and who it's for
- [Architecture](./docs/02-architecture.md) — components and how they fit
- [Tech stack](./docs/03-tech-stack.md) — chosen tech with rationale
- [Data model](./docs/04-data-model.md) — Prisma schema, indexes, retention
- [API surface](./docs/05-api-surface.md) — REST endpoints
- [Desktop app](./docs/06-desktop-app.md) — Tauri client design
- [Screenshot pipeline](./docs/07-screenshot-pipeline.md) — capture to display
- [Auth & permissions](./docs/08-auth-and-permissions.md) — multi-tenancy, roles
- [Privacy & ethics](./docs/09-privacy-and-ethics.md) — what we will and won't capture
- [Roadmap](./docs/10-roadmap.md) — milestones
- [Glossary](./docs/11-glossary.md) — terms

## Tech at a glance

- **Backend:** Node 20, TypeScript, Fastify, Prisma, PostgreSQL, Redis, BullMQ
- **Web:** React 18, Vite, TanStack Router/Query, Tailwind, shadcn/ui
- **Desktop:** Tauri 2 (Rust + React), SQLite outbox
- **Storage:** Cloudflare R2 (S3-compatible) for screenshots
- **Hosting:** Single VPS via Docker Compose; Cloudflare in front

Full rationale in [`docs/03-tech-stack.md`](./docs/03-tech-stack.md).

## Quick start (development)

> Setup will firm up once `apps/api` lands. The flow below is the planned one.

**Prerequisites:**
- Node.js 20 LTS
- pnpm 9+
- Docker (for Postgres + Redis)
- Rust toolchain (only if working on `apps/desktop`)

**Bootstrap:**

```bash
# Install all workspace deps
pnpm install

# Start Postgres + Redis
docker compose up -d

# Copy env template and fill in
cp .env.example .env

# Run migrations
pnpm --filter api db:migrate

# Run the API + a worker (separate terminals or via a process manager)
pnpm --filter api dev
pnpm --filter api worker

# Run the web app
pnpm --filter web dev

# Run the desktop app (requires Rust)
pnpm --filter desktop tauri:dev
```

The API is at `http://localhost:3001`, web at `http://localhost:5173`. The desktop app points at the API URL configured in its `.env`.

## Environment variables

The full list lives in `.env.example` (committed) once the API exists. Highlights:

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | api, worker | Postgres connection string |
| `REDIS_URL` | api, worker | Redis connection string |
| `SESSION_SECRET` | api | Cookie signing key |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | api, worker | Cloudflare R2 credentials |
| `R2_BUCKET` | api, worker | Bucket name for screenshots |
| `MAIL_PROVIDER_API_KEY` | api | Resend or Postmark key |
| `PUBLIC_API_URL` | web, desktop | Where clients call the API |

Never commit a real `.env`. Production values live in the deploy host's secret store.

## Repo layout conventions

- TypeScript everywhere it can be. Strict mode on.
- ESLint + Prettier; commits run them via `lint-staged`.
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`).
- Branches: `main` is always deployable. Feature branches off `main`, PRs reviewed before merge.
- IDs are ULIDs at the application layer, never sequential integers.
- Times are UTC in the DB; conversion at the UI layer.
- Money is integer cents.
- API paths are kebab-case; JSON fields are camelCase.

## Working with LLMs on this codebase

The `/docs` folder is structured to be loaded into an LLM's context. When asking an LLM to make changes:

1. Point it at `docs/README.md` first so it understands the product shape.
2. For schema or API changes, also include the relevant doc(s) — the LLM should update them in the same PR.
3. If the LLM proposes something that contradicts a doc, it's the LLM's job to either justify changing the doc or back off the change.

Treat the docs as part of the source code, because they are.

## Scripts (root)

| Script | What it does |
|---|---|
| `pnpm dev` | Run API + web concurrently |
| `pnpm build` | Build all apps |
| `pnpm test` | Run tests across all packages |
| `pnpm lint` | Lint everything |
| `pnpm format` | Prettier write |
| `pnpm db:migrate` | Run pending Prisma migrations |
| `pnpm db:studio` | Open Prisma Studio against local DB |

## Deploy

Production is a single VPS running `docker-compose.prod.yml` with the API, a worker, Postgres, and Redis. Cloudflare handles DNS and TLS. R2 handles screenshot storage. Backups: nightly `pg_dump` to a separate R2 bucket, 30-day retention.

CI deploys `main` on green via SSH + `docker compose pull && up -d`. See `.github/workflows/deploy.yml` once it lands.

## License

Internal — not currently licensed for external use. Reach out before forking or deploying for another team.

## Contact

Project owner: _TBD_. Open an issue for anything else.

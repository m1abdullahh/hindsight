# Hindsight

Internal screenshot-based time tracking for small teams. Members install a desktop app, pick a project, and start a timer. While tracking, the app captures periodic screenshots and aggregate activity metrics, then uploads them to a server. Managers and members both view their data through the same web app, scoped by role.

> **Status:** All three apps in active development.
>
> - **API** (Plans 00–05, 09): auth + orgs + members + invitations + projects + assignments + screenshot ingestion + reports. Tests passing against Neon.
> - **Web** (Plans 06, 07, plus reports + screenshots gallery): admin and member portals — orgs, members, projects, screenshot gallery per project, time-totals reports (per-project + org-wide).
> - **Desktop** (Plan 08, plus notifications + baseline timer): Tauri 2 tracker — login, picker, capture loop, outbox uploader, OS toasts on capture, "My time" panel, today-aware tracker timer. Windows installer signs + branded toasts via AUMID registration.
>
> Architecture and product decisions live in [`/docs`](./docs); concrete execution plans in [`/plans`](./plans).

---

## What's in this repo

```
hindsight/
├── apps/
│   ├── api/         # Express + TypeScript backend (REST, workers, presigning)
│   ├── web/         # React + Vite SPA — admin and member portals
│   └── desktop/     # Tauri 2 app (Win/Mac) — screenshot capture, outbox
├── packages/
│   └── shared/      # Zod schemas, TS types, capability matrix shared across apps
├── docs/            # Source of truth for product + architecture decisions
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

- **Backend:** Node 20, TypeScript, Express, Prisma, PostgreSQL (Neon), Redis (Upstash), BullMQ
- **Web:** React 18, Vite, TanStack Router/Query, Tailwind, shadcn/ui
- **Desktop:** Tauri 2 (Rust + React), SQLite outbox
- **Storage:** Cloudflare R2 (S3-compatible) for screenshots
- **Hosting:** Serverless cloud services (Neon + Upstash + R2); Cloudflare in front of the API host

Full rationale in [`docs/03-tech-stack.md`](./docs/03-tech-stack.md).

## Quick start (development)

**Prerequisites:**

- Node.js 20+ (22 LTS works)
- pnpm 9+
- A Neon project (Postgres) — https://console.neon.tech
- An Upstash Redis database — https://console.upstash.com
- Rust toolchain (only when the desktop plan lands)

**Bootstrap:**

```bash
# Install all workspace deps
pnpm install

# Copy env template — gitignored .env is read by the api.
# Fill in DATABASE_URL (Neon) and REDIS_URL (Upstash).
cp .env.example apps/api/.env

# Generate the Prisma client and apply migrations to your Neon DB
pnpm --filter @hindsight/api db:generate
pnpm --filter @hindsight/api db:migrate

# Run the API (PORT 3001 by default)
pnpm --filter @hindsight/api dev

# In a second terminal, run the worker
pnpm --filter @hindsight/api worker
```

Smoke test:

```bash
curl http://localhost:3001/healthz
# => {"ok":true,"version":"dev"}
```

In separate terminals, run the web and desktop apps too:

```bash
pnpm --filter @hindsight/web dev          # Vite dev server, port 5173
pnpm --filter @hindsight/desktop tauri:dev # Tauri shell + Vite for the desktop UI
```

To produce a Windows installer:

```bash
pnpm --filter @hindsight/desktop tauri:build
# → apps/desktop/src-tauri/target/release/bundle/nsis/Hindsight_0.1.0_x64-setup.exe
```

## Environment variables

The full list lives in `.env.example` (committed) once the API exists. Highlights:

| Variable                                                      | Used by      | Purpose                                               |
| ------------------------------------------------------------- | ------------ | ----------------------------------------------------- |
| `DATABASE_URL`                                                | api, worker  | Neon Postgres connection string (`?sslmode=require`)  |
| `TEST_DATABASE_URL`                                           | tests        | Neon test branch URL — used by `pnpm db:test:migrate` |
| `REDIS_URL`                                                   | api, worker  | Upstash Redis connection string (`rediss://`)         |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | api, worker  | Cloudflare R2 credentials                             |
| `R2_BUCKET`                                                   | api, worker  | Bucket name for screenshots                           |
| `MAIL_PROVIDER_API_KEY`                                       | api          | Resend or Postmark key                                |
| `PUBLIC_API_URL`                                              | web, desktop | Where clients call the API                            |

Bearer tokens are stored as `sha256(token)` in the DB, so there is no `SESSION_SECRET`.

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

| Script            | What it does                                                    |
| ----------------- | --------------------------------------------------------------- |
| `pnpm dev`        | Run API + web concurrently (web is a stub until its plan lands) |
| `pnpm build`      | Build every workspace via `pnpm -r build`                       |
| `pnpm test`       | Run tests across every workspace                                |
| `pnpm lint`       | ESLint over the whole repo                                      |
| `pnpm format`     | Prettier write                                                  |
| `pnpm typecheck`  | `tsc --noEmit` in every workspace                               |
| `pnpm db:migrate` | Run pending Prisma migrations against `DATABASE_URL` (Neon)     |
| `pnpm db:studio`  | Open Prisma Studio against the configured DB                    |

## Deploy

Production runs the API + worker on a serverless host (Railway/Fly.io/Render — TBD), with Postgres on **Neon** and Redis on **Upstash**. Cloudflare handles DNS and TLS for the API hostname. R2 handles screenshot storage. Backups: Neon's point-in-time recovery on the paid tier, plus a periodic `pg_dump` to R2 for cold archive.

CI deploys `main` on green. See `.github/workflows/deploy.yml` once it lands.

## License

Internal — not currently licensed for external use. Reach out before forking or deploying for another team.

## Contact

Project owner: _TBD_. Open an issue for anything else.

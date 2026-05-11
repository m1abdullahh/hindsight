# Monorepo — Directory Structure

Target tree after this plan executes (no source files yet, just slots):

```
hindsight/
├── apps/
│   ├── api/
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── web/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── desktop/
│       ├── package.json
│       └── tsconfig.json
├── packages/
│   └── shared/
│       ├── src/index.ts          # empty export {}
│       ├── package.json
│       └── tsconfig.json
├── docs/                          # already exists
├── plans/                         # this folder
├── .github/
│   └── workflows/                 # placeholder; CI plan fills it
├── .husky/
│   └── pre-commit
├── .editorconfig
├── .env.example
├── .eslintignore
├── .gitignore
├── .prettierignore
├── .prettierrc
├── eslint.config.js
├── commitlint.config.cjs
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── README.md                      # already exists
```

## Naming conventions enforced from day one

- **App / package names:** `@hindsight/api`, `@hindsight/web`, `@hindsight/desktop`, `@hindsight/shared`
- **TS path aliases:** `@hindsight/shared` → `packages/shared/src`
- **IDs:** ULID at the application layer ([README.md:114](../../README.md#L114))
- **Timestamps:** UTC in DB; convert at UI ([README.md:115](../../README.md#L115))
- **Money:** integer cents in `*_cents` columns ([README.md:116](../../README.md#L116))
- **API paths:** kebab-case; **JSON fields:** camelCase ([README.md:117](../../README.md#L117))

## `pnpm-workspace.yaml`

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

## Root `package.json` shape

- `"private": true`
- `"type": "module"`
- `"engines": { "node": ">=20", "pnpm": ">=9" }`
- Scripts (mirrors [README.md:131-139](../../README.md#L131-L139)):
  - `dev` — `pnpm -r --parallel --filter "./apps/api" --filter "./apps/web" dev`
  - `build` — `pnpm -r build`
  - `test` — `pnpm -r test`
  - `lint` — `eslint .`
  - `format` — `prettier --write .`
  - `typecheck` — `pnpm -r typecheck`
  - `db:migrate` — `pnpm --filter @hindsight/api db:migrate`
  - `db:studio` — `pnpm --filter @hindsight/api db:studio`
  - `prepare` — `husky`

## Stateful services (managed, no local containers)

Postgres and Redis are not run locally. Each developer creates their own free-tier accounts:

- **Postgres → [Neon](https://console.neon.tech)**. One project per developer; use Neon's branching to split `dev` and `test` databases (the test branch is what `pnpm db:test:migrate` targets).
- **Redis → [Upstash](https://console.upstash.com)**. One database per developer. Use the `rediss://` (TLS) URL.

The free tiers are sufficient for personal dev. Neon's compute auto-suspends when idle, so the first request after a pause may take 3–10s — this is normal and is why bearer-auth and Prisma calls retry transparently.

A managed-service deploy spec for prod (which provider runs the API/worker, secret store, etc.) lands in the deploy plan (P0 #6), not here.

## `.env.example`

Committed at root. Concrete values live in a gitignored `.env`. Initial keys (filled in over later plans):

```
# Postgres — Neon serverless connection string
DATABASE_URL=postgresql://USER:PASSWORD@HOST.neon.tech/DBNAME?sslmode=require

# Test DB — separate Neon branch used by `pnpm db:test:migrate` and the test suite
TEST_DATABASE_URL=postgresql://USER:PASSWORD@HOST.neon.tech/DBNAME-test?sslmode=require

# Redis — Upstash serverless connection string (rediss:// for TLS)
REDIS_URL=rediss://default:TOKEN@HOST.upstash.io:6379

# API
NODE_ENV=development
PORT=3001
PUBLIC_API_URL=http://localhost:3001
WEB_ORIGIN=http://localhost:5173    # CORS allow-list; tokens are sent in Authorization header, no cookies

# Web
VITE_API_URL=http://localhost:3001

# R2 (filled when ingestion plan lands)
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=

# Mail
MAIL_PROVIDER_API_KEY=
```

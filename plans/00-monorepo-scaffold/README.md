# Plan 00 — Monorepo Scaffold

> Roadmap milestone: **v0.1 Foundations** ([docs/10-roadmap.md:5-17](../../docs/10-roadmap.md#L5-L17))
> Priority bucket: **P0**

## Goal

Stand up an empty but cohesive `pnpm` workspace with `apps/api`, `apps/web`, `apps/desktop`, `packages/shared` so subsequent plans can drop code into their slot without arguing about layout, tooling, or scripts.

## Why this plan exists separately

The scaffold is a one-time, foundational decision. Doing it once and recording it here means [Plan 01 — Backend Structure](../01-backend-structure/README.md) and the later web/desktop plans only need to talk about _their_ code, not about workspace plumbing.

## Source-of-truth references

- Repo layout target: [README.md:11-22](../../README.md#L11-L22)
- Tech stack: [docs/03-tech-stack.md](../../docs/03-tech-stack.md)
- Conventions (TS strict, ESLint+Prettier, conventional commits, ULIDs, UTC, integer cents): [README.md:108-117](../../README.md#L108-L117)

## Deliverables

- `pnpm-workspace.yaml`, root `package.json` with shared scripts
- `tsconfig.base.json` extended by every app/package
- ESLint (flat config) + Prettier + `lint-staged` + `husky` pre-commit
- `commitlint` enforcing conventional commits (optional but in line with docs)
- `.editorconfig`, `.gitignore`, `.env.example`
- Empty `apps/api`, `apps/web`, `apps/desktop`, `packages/shared` with their own `package.json` + `tsconfig.json` extending the base
- `.env.example` documents Neon (Postgres) and Upstash (Redis) connection strings — no local Docker required
- Updated root `README.md` quick-start matches reality

## Out of scope (handled by later plans)

- Any source files inside `apps/*` — that's Plan 01 (api), Plan 02 (web), Plan 03 (desktop)
- Prisma schema — Plan 01
- CI workflow, serverless deploy (Railway/Fly.io/Render), Cloudflare — separate P0 items
- Cert procurement (Apple Dev / Windows EV) — separate P0 item, parallel track

## Files in this plan

- [structure.md](./structure.md) — exact directory tree we're creating
- [tooling.md](./tooling.md) — versions, configs, scripts, commit hooks

## Ordered execution checklist

1. Init repo root: `package.json` (private, `"type": "module"`), `pnpm-workspace.yaml`
2. Add `tsconfig.base.json` (strict, ES2022, paths for `@hindsight/shared`)
3. Add `.editorconfig`, `.gitignore`, `.env.example`, `.prettierrc`, ESLint flat config
4. Add `husky` + `lint-staged` + `commitlint`
5. Scaffold `packages/shared` with empty `index.ts` + `tsconfig.json` extends base
6. Scaffold `apps/api`, `apps/web`, `apps/desktop` (empty `package.json` + `tsconfig.json` only)
7. Document Neon + Upstash setup in `.env.example` (no local containers — devs create their own free-tier projects)
8. Wire root scripts: `dev`, `build`, `test`, `lint`, `format`, `db:migrate`, `db:studio`
9. Run `pnpm install` — must succeed on a clean clone
10. Update root `README.md` quick-start so the listed commands match what's wired

## Done when

- A fresh clone + `pnpm install` succeeds, and the documented `DATABASE_URL` (Neon) + `REDIS_URL` (Upstash) values let the API connect on first boot
- `pnpm lint` and `pnpm -r typecheck` both pass against the empty workspace
- A pre-commit hook on a deliberately bad file blocks the commit

# Plan 05 — Screenshot Ingestion

> Roadmap milestone: **v0.4 Screenshot ingestion** ([docs/10-roadmap.md:39-47](../../docs/10-roadmap.md#L39-L47))
> Priority bucket: **P1** (depends on Plan 04; required for the desktop plan)

## Goal

Land the full server-side path that takes a screenshot from the desktop app and ends up with a thumbnail in R2 plus a row visible in the admin dashboard. Concretely:

- Desktop registers as a **device** and gets a long-lived device token.
- Desktop creates a **time entry** when the user clicks Start; updates it with activity counters; closes it when the user clicks Stop.
- Desktop **presigns** an upload URL, **PUTs** bytes directly to R2, then **confirms** with metadata.
- The API enqueues a `process-screenshot` job; a BullMQ worker generates a thumbnail (and applies blur if the project's `blurScreenshots` flag is set), and writes both back to R2.
- Admins read screenshots through paginated endpoints that hand back **presigned GET URLs** for thumbnails — bytes never flow through the API.

This is the biggest plan so far. It's the difference between "a backend that knows about projects" and "a backend that runs the actual product."

## Source-of-truth references

- Pipeline (capture → R2 → process → view): [docs/07-screenshot-pipeline.md](../../docs/07-screenshot-pipeline.md)
- Architecture (direct-to-R2 uploads, BullMQ workers): [docs/02-architecture.md](../../docs/02-architecture.md)
- Data model (`Device`, `TimeEntry`, `Screenshot`): [docs/04-data-model.md:148-251](../../docs/04-data-model.md#L148-L251)
- API surface (devices, time entries, screenshots): [docs/05-api-surface.md:78-129](../../docs/05-api-surface.md#L78-L129)
- Desktop expectations (capture loop, idle, outbox): [docs/06-desktop-app.md](../../docs/06-desktop-app.md)
- Auth model (device tokens, `Idempotency-Key`): [docs/08-auth-and-permissions.md](../../docs/08-auth-and-permissions.md)
- Privacy guardrails (what we don't capture): [docs/09-privacy-and-ethics.md](../../docs/09-privacy-and-ethics.md)

## Decisions captured here (not implementation yet)

1. **Cloudflare R2 via the AWS S3 SDK v3.** R2 is S3-compatible. Using `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` keeps us on a battle-tested SDK and lets us swap providers (real S3, MinIO for testing) by changing the endpoint URL. No vendor-specific R2 SDK.
2. **Object keys partition by org and date** so retention sweeps can target prefixes:
   - Original: `orgs/{orgId}/users/{userId}/{yyyy}/{mm}/{dd}/{screenshotId}.jpg`
   - Thumbnail: `orgs/{orgId}/users/{userId}/{yyyy}/{mm}/{dd}/{screenshotId}-thumb.webp`
   - Blurred full: `orgs/{orgId}/users/{userId}/{yyyy}/{mm}/{dd}/{screenshotId}-blur.jpg` (only when project has `blurScreenshots = true`)
3. **Presign TTLs differ by purpose.** PUT URLs: 5 minutes (per [docs/07-screenshot-pipeline.md:46](../../docs/07-screenshot-pipeline.md#L46)). Thumbnail GET: 10 minutes. Full-res GET: 5 minutes (refresh per click; minimizes accidental URL sharing).
4. **Allowed Content-Types: `image/jpeg`, `image/png`, `image/webp`.** Anything else → reject at presign with 422. The presigned URL also restricts the upload's `Content-Type` to the requested value, and a max object size of 8 MB.
5. **Screenshot row is created at presign time with `status = 'pending'`.** Confirm flips to `'uploaded'` and enqueues the worker. Worker flips to `'processed'` (or `'failed'` after exhausted retries). This three-step write means a crash anywhere leaves a row visible to a reconciliation worker (out of scope for this plan, mentioned for completeness).
6. **Idempotency-Key is required on every desktop write endpoint.** That's already in [docs/05-api-surface.md:13](../../docs/05-api-surface.md#L13). Plan 01's idempotency middleware exists but isn't wired anywhere; this plan wires it. Web-token endpoints don't require it (the web app doesn't replay).
7. **Devices module is small but needs its own URL family** — `/devices/register`, `/devices`, `/devices/:id`, `/devices/heartbeat`. Registration uses a _web_ token and mints a _device_ token. All other device endpoints use the device token and identify themselves via the token.
8. **TimeEntry's `deviceId` is required.** Even when the desktop creates a time entry over a flaky network, the device that owns it is fixed. There's no "started from the web" path in this plan; if we add one later, we'll add a sentinel device row per user.
9. **A device can have at most one _open_ time entry** (`endedAt = null`). Starting a new one when one is already open auto-stops the previous (server fills `endedAt = now()` on the old row, returns the new one). This is the simplest UX: the desktop app should never send two starts, but we don't crash if it does.
10. **Activity counters are cumulative on the time entry, not per screenshot.** Each `PATCH /time-entries/:id` carries the **running totals** the desktop has accumulated since start. Server overwrites; desktop owns the accumulator. This makes resync after offline windows trivial.
11. **The capture-time grace window is 5 minutes** after a time entry's `endedAt`. A presign request for a screenshot with `capturedAt` more than 5 minutes after the entry was closed → 422. (Outbox uploads from before the user clicked Stop are normal and must succeed.)
12. **Workers actually do work this plan.** The `process-screenshot` stub from Plan 01 is replaced. It uses `sharp` for the thumbnail (480px on the long edge, JPEG quality 70) and the blurred full (`sharp().blur(20)` if the project has `blurScreenshots = true`). Both go to R2 with the keys above.
13. **R2 client is lazy and optional in dev.** Like the mail provider, R2 is constructed at first use. If the env vars are missing, presign / confirm endpoints return `503 r2_unavailable`. The worker is similar — if R2 isn't configured it logs and short-circuits to `failed`. Tests use a stub provider.
14. **No real retention sweeper this plan.** `Screenshot.deletedAt` exists in the schema and `DELETE /screenshots/:id` writes to it, but we don't run a daily sweep that hard-deletes from R2 (that lands in v0.9 hardening). The schema is positioned for it.
15. **No reconciliation-orphan worker either.** Same reasoning. Stuck-in-pending rows are a known gap; the desktop's outbox retries cover most cases in practice.
16. **All listing endpoints return paginated metadata** with cursor pagination per [docs/05-api-surface.md:11](../../docs/05-api-surface.md#L11). Default `limit = 50`, max `100`.

## Out of scope for this plan (deferred)

- The **desktop app itself** — that's Plan 06+. This plan only ships the API and worker.
- **Retention sweeper** — v0.9 hardening.
- **Orphan reconciliation worker** — v0.9 hardening.
- **Reports endpoints** (`/reports/timesheet`, `/reports/activity`) — separate plan; depends on this one.
- **Idle prompt UX flow** — that's the desktop's job; the API only stores `totalIdleSeconds`.
- **Crash-resilient resume** ("user closes laptop, opens it 3 hours later, time entry should resume") — out of scope; the desktop owns this state machine.
- **Screenshot search / filtering by activity threshold** — listing exists, complex filtering is deferred.

## Files in this plan

- [schema.md](./schema.md) — `TimeEntry` and `Screenshot` Prisma additions, status enum, indexes, migration sequence
- [r2.md](./r2.md) — R2 client setup, presign helpers, key scheme, env-var policy
- [modules.md](./modules.md) — three new modules (devices, time-entries, screenshots) — routes, schemas, services
- [worker.md](./worker.md) — replacing the `process-screenshot` stub with sharp + R2 round-trip
- [testing.md](./testing.md) — strategy for testing presign / confirm / worker without hitting real R2

## Ordered execution checklist

1. **Install deps.** `pnpm add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner sharp` and `pnpm add -D @types/sharp`. Sharp ships native binaries; `pnpm` rebuilds them on first install.
2. **Schema migration.** Add `TimeEntry`, `Screenshot`, `ScreenshotStatus` enum + back-relations. `prisma migrate dev --name screenshot_ingestion`. Run `pnpm db:test:migrate` against the test branch.
3. **Update `truncateAll()` test helper** to include `screenshots`, `time_entries` (in order; both must come before `users`/`projects`/`devices`).
4. **R2 client + presign helpers.** `apps/api/src/lib/r2.ts` exports `getPutPresignedUrl(key, contentType)`, `getGetPresignedUrl(key)`, `deleteObject(key)`, `__setR2Provider` (test seam). Lazy init from env (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`).
5. **Idempotency middleware** is already implemented from Plan 01 — just attach it to the relevant routes in steps 6–8.
6. **Devices module:** `src/modules/devices/` — `routes.ts`, `schemas.ts`, `handlers.ts`, `service.ts`. Endpoints: `POST /devices/register`, `GET /devices`, `DELETE /devices/:deviceId`, `POST /devices/heartbeat`.
7. **Time-entries module:** `src/modules/time-entries/` — same shape. Endpoints: `POST /time-entries`, `PATCH /time-entries/:id`, `GET /orgs/:orgId/time-entries`.
8. **Screenshots module:** `src/modules/screenshots/` — same shape. Endpoints: `POST /screenshots/presign`, `POST /screenshots/:id/confirm`, `GET /orgs/:orgId/screenshots`, `GET /screenshots/:id`, `DELETE /screenshots/:id`.
9. **Wire all three routers** into `apps/api/src/modules/index.ts` (three lines).
10. **Replace the `process-screenshot` worker stub** with the real implementation. Idempotent — re-running on a screenshot already `processed` is a no-op.
11. **Audit additions.** `device.registered`, `device.revoked`, `screenshot.deleted` were already in the union from Plan 02; this plan emits them.
12. **Tests.** Unit tests for the R2 helpers (mocked SDK); integration tests for the device + time-entry + screenshot endpoints; a worker-loop test that runs `process-screenshot` against a stub R2 and asserts state transitions.
13. **Lint, typecheck, test all green** before merging.
14. **Manual smoke test** with `curl` + a real PNG, end to end. Per the v0.4 done-when criteria.

## Done when

- A user can `POST /api/v1/devices/register` (with their web bearer token + `Idempotency-Key`) and receive `{ deviceId, deviceToken }`.
- That device token authenticates `POST /api/v1/time-entries` with `{ projectId, startedAt }`, returning a `TimeEntry` row with `endedAt: null`.
- The device can `POST /api/v1/screenshots/presign` and receive a working PUT URL. `curl -T some.jpg <putUrl>` lands the bytes in R2 (verifiable via the R2 dashboard or a `GET` presign).
- `POST /api/v1/screenshots/:id/confirm` flips the row to `uploaded` and enqueues the worker.
- The worker generates a `*-thumb.webp` object in R2 and updates the row to `processed` with `thumbnailS3Key` set.
- `GET /api/v1/orgs/:orgId/screenshots?limit=10` returns the row with a presigned thumbnail URL the browser can fetch directly.
- `DELETE /api/v1/screenshots/:id` sets `deletedAt`. Subsequent reads return 404.
- Idempotency: posting the same `Idempotency-Key` twice to `/screenshots/presign` returns the _same_ `screenshotId` and presign URL.
- All audit rows from this plan exist (`device.registered`, `device.revoked`, `screenshot.deleted`).
- `pnpm typecheck` and `pnpm test` pass; the worker test runs against the stub and asserts the row reaches `processed`.
- A `curl`-driven end-to-end smoke (signup → login → device register → create project → start time entry → presign → PUT → confirm → list → fetch thumbnail) succeeds against a real Neon DB and a real R2 bucket.

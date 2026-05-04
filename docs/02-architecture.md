# 02 — Architecture

## Components

```
┌─────────────────────┐         ┌─────────────────────┐
│   Desktop App       │         │   Web App (SPA)     │
│   (Tauri, Win/Mac)  │         │   (React + Vite)    │
└──────────┬──────────┘         └──────────┬──────────┘
           │                               │
           │ HTTPS (device token)          │ HTTPS (session cookie)
           │                               │
           └───────────┬───────────────────┘
                       │
                       ▼
            ┌──────────────────────┐
            │   API Server         │
            │   (Fastify + TS)     │
            └──────────┬───────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
        ▼              ▼              ▼
   ┌─────────┐   ┌──────────┐   ┌──────────┐
   │Postgres │   │  Redis   │   │   R2     │
   │(metadata│   │(sessions,│   │(screen-  │
   │ + auth) │   │  queues) │   │ shots)   │
   └─────────┘   └──────────┘   └──────────┘
                       │
                       ▼
                ┌─────────────┐
                │  BullMQ     │
                │  Workers    │
                │ (thumbs,    │
                │  blur,      │
                │  cleanup)   │
                └─────────────┘
```

## Why this shape

**One API server for both clients.** No separate "tracker API" and "web API." The endpoints differ but they live in one codebase, share auth primitives, and use the same database connection pool. Splitting before there's pain is premature.

**Direct-to-storage uploads.** Desktop clients never push screenshot bytes through the API. The API issues a presigned PUT URL to R2; the client uploads directly. The API server only handles JSON metadata. This keeps the Node process memory profile flat regardless of capture volume.

**Background workers, not request-time work.** Thumbnail generation, blur application, and retention cleanup all happen in BullMQ workers that read from Redis. The API responds fast; workers chew through the queue async.

**Single Postgres, multi-tenant by `org_id`.** No schema-per-tenant, no separate databases. Every tenant-scoped query filters by `org_id` and we enforce it at the application layer. At 50–500 users this is correct; revisit at 5000+.

## Request paths

### Desktop app captures a screenshot

1. Capture loop fires (random offset within current 10-min window).
2. App writes screenshot bytes + metadata to local SQLite (offline-safe).
3. Upload worker (in-app) picks up the row.
4. `POST /screenshots/presign` → API returns `{ screenshotId, putUrl, expiresAt }`.
5. App PUTs bytes directly to R2 at `putUrl`.
6. `POST /screenshots/:id/confirm` with metadata (size, dimensions, capture time, activity counts, active window title, active app, monitor index).
7. API enqueues a `process-screenshot` job (thumbnail + optional blur).
8. Worker writes thumbnail to R2, updates the screenshot row.
9. Local SQLite row is marked uploaded and deleted after a retention window.

### Admin views screenshots

1. Browser hits `/orgs/:orgId/screenshots?...filters`.
2. API returns paginated metadata + presigned GET URLs for thumbnails.
3. Browser lazy-loads thumbnails directly from R2.
4. Click a thumbnail → fetch presigned URL for full-res, open in modal.

## Deployment

- **Single VPS (Hetzner CX22 or DO equivalent, ~$10–20/mo)** for API + Postgres + Redis + worker, all via Docker Compose. Vertical scale until something hurts.
- **Cloudflare R2** for object storage. Zero egress fees matter when admins scroll through screenshots.
- **Cloudflare in front** for DNS, TLS, CDN of static web assets.
- **Backups:** nightly `pg_dump` to a separate R2 bucket, 30-day retention.

## What we explicitly didn't do

- **No Kubernetes.** A compose file beats a cluster at this scale.
- **No microservices.** One backend service.
- **No GraphQL.** REST + TanStack Query covers it; GraphQL adds machinery we don't need.
- **No event sourcing.** Plain CRUD with an audit log table.
- **No separate "ingest" service.** R2 is the ingest service.

## Scaling escape hatches (when, not if)

- If Postgres becomes hot: read replica for the dashboard queries, primary for writes.
- If the worker falls behind: horizontal scale on the worker container; queue is already in Redis.
- If a single org gets huge: that's when `org_id`-based partitioning becomes interesting.

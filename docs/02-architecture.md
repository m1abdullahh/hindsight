# 02 — Architecture

## Components

```
┌─────────────────────┐         ┌─────────────────────┐
│   Desktop App       │         │   Web App (SPA)     │
│   (Tauri, Win/Mac)  │         │   (React + Vite)    │
└──────────┬──────────┘         └──────────┬──────────┘
           │                               │
           │ HTTPS (bearer token)          │ HTTPS (bearer token)
           │                               │
           └───────────┬───────────────────┘
                       │
                       ▼
            ┌──────────────────────┐
            │   API Server         │
            │   (Express + TS)     │
            └──────────┬───────────┘
                       │
        ┌──────────────┼──────────────┐
        │              │              │
        ▼              ▼              ▼
   ┌─────────┐   ┌──────────┐   ┌──────────┐
   │ Neon    │   │ Upstash  │   │   R2     │
   │Postgres │   │  Redis   │   │(screen-  │
   │(metadata│   │(tokens,  │   │ shots)   │
   │ + auth) │   │  queues) │   │          │
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

- **Serverless cloud services** for the stateful pieces — **Neon** for Postgres, **Upstash** for Redis, **Cloudflare R2** for object storage. No self-hosted DB or queue.
- **API + worker** run on a serverless host (Railway / Fly.io / Render — picked when the deploy plan lands). One process for the API, one for the worker; both read the same Neon + Upstash URLs.
- **Cloudflare** in front for DNS, TLS, and CDN of static web assets.
- **Backups:** Neon's point-in-time recovery on the paid tier; periodic `pg_dump` to R2 for a cold archive.
- **Local dev** uses the same Neon + Upstash URLs (a personal "dev" Neon branch keeps state isolated from prod). No Docker.

## What we explicitly didn't do

- **No self-hosted Postgres or Redis.** Neon + Upstash remove an entire ops surface.
- **No Docker Compose for local dev.** The serverless free tiers cover personal dev cleanly.
- **No Kubernetes.** Out of scope at this scale.
- **No microservices.** One backend service.
- **No GraphQL.** REST + TanStack Query covers it; GraphQL adds machinery we don't need.
- **No event sourcing.** Plain CRUD with an audit log table.
- **No separate "ingest" service.** R2 is the ingest service.

## Scaling escape hatches (when, not if)

- If Postgres becomes hot: Neon supports read replicas on its paid tiers; route dashboard queries to a replica and writes to the primary.
- If the worker falls behind: horizontal scale on the worker process; queue is already in Upstash Redis.
- If Neon's quota becomes a problem: the schema is portable, so a managed RDS / self-hosted Postgres is a one-`DATABASE_URL` swap.
- If a single org gets huge: that's when `org_id`-based partitioning becomes interesting.

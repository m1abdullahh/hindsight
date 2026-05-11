# 03 — Tech Stack

Every choice here is deliberate. If you want to change one, justify it against the alternatives listed.

## Backend

| Concern              | Choice                                    | Why                                                                            |
| -------------------- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| Runtime              | Node.js 20 LTS                            | Team strength; ecosystem                                                       |
| Language             | TypeScript (strict)                       | Catches the dumb bugs                                                          |
| Framework            | Express 4                                 | Boring, ubiquitous, team familiarity; perf is fine at our scale                |
| Validation           | Zod                                       | Single source of truth: types + runtime validation                             |
| ORM                  | Prisma                                    | Migrations, type-safe queries, decent DX                                       |
| Database             | PostgreSQL 16 on **Neon** (serverless)    | Boring and bulletproof; Neon adds branching, autoscale, and free-tier dev      |
| Cache / queue broker | Redis 7 on **Upstash** (serverless)       | Bearer tokens are in Postgres; Upstash holds rate-limit counters + BullMQ jobs |
| Job queue            | BullMQ                                    | Best-in-class for Node, Redis-backed                                           |
| Auth                 | Opaque bearer tokens, sha256-hashed in DB | Simple, server-side revocable, no vendor lock-in, no JWT denylist              |
| Object storage       | Cloudflare R2                             | S3-compatible, zero egress fees                                                |
| Image processing     | sharp                                     | Standard for thumbnail/blur work in Node                                       |
| Mail                 | Resend or Postmark                        | Transactional email for invites/magic links                                    |
| Logging              | pino                                      | Fast, JSON-structured                                                          |
| Errors               | Sentry (self-hosted optional)             | Same in dev and prod                                                           |

### Why not...

- **Fastify?** Considered for built-in schema validation and faster benchmarks. We picked Express anyway: it's universally understood, the integration ecosystem is larger, and the perf delta doesn't matter at 50–500 users. Validation is added explicitly via Zod middleware.
- **NestJS?** Decorators-everywhere is overkill for this size.
- **JWT?** Stateless tokens force a denylist for revocation, which negates the property. Opaque tokens with a single DB lookup are simpler and meet our requirements.
- **Drizzle?** Fine choice — Prisma wins on migrations UX and team familiarity. Revisit if Prisma's runtime cost bites.
- **TypeORM?** No.
- **Supabase?** Couples our auth + storage + DB to a vendor with one bundled product. We want the DB and storage to be independently swappable, which Neon + R2 give us.

## Web app

| Concern       | Choice                             | Why                                                |
| ------------- | ---------------------------------- | -------------------------------------------------- |
| Framework     | React 18                           | Team strength                                      |
| Build         | Vite                               | Fast, no bullshit                                  |
| Routing       | TanStack Router                    | Type-safe, file-based optional                     |
| Server state  | TanStack Query                     | Cache + refetch are solved problems                |
| Client state  | Zustand for the little bit we need | Redux is too much                                  |
| Styling       | Tailwind CSS                       | Velocity                                           |
| Components    | shadcn/ui                          | Copy-paste components we own                       |
| Forms         | React Hook Form + Zod              | Validates with the same schema as the API          |
| Charts        | Recharts                           | Hours-by-day, activity sparklines                  |
| Date handling | date-fns                           | Lighter than moment, saner than Day.js for our use |

### Why not...

- **Next.js?** We don't need SSR for an internal authenticated dashboard. Vite is faster to develop against.
- **Redux Toolkit?** Overkill. TanStack Query + a tiny Zustand store cover us.
- **Material UI / Chakra?** Heavy and opinionated. shadcn lets us own the components.

## Desktop app

| Concern                | Choice                                                                              | Why                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell                  | Tauri 2                                                                             | ~10 MB bundle vs Electron's ~120 MB; lower RAM footprint matters when it runs all day                                                           |
| UI                     | React (shared with web)                                                             | Component reuse                                                                                                                                 |
| Local DB               | SQLite via `sqlx`                                                                   | Offline screenshot queue                                                                                                                        |
| Screenshot capture     | Rust `screenshots` crate (sidecar command)                                          | Cross-platform, multi-monitor                                                                                                                   |
| Idle detection         | `user-idle` Rust crate (data-only for now; not yet wired into `totalActiveSeconds`) | Uniform Win/Mac API                                                                                                                             |
| Tray                   | Tauri's tray API                                                                    | Built in                                                                                                                                        |
| Notifications          | `tauri-plugin-notification`                                                         | Native OS toasts on every capture (replaces the original "capture flash overlay" idea)                                                          |
| Windows toast branding | `windows` crate (`Win32_UI_Shell`) + `winreg`                                       | Sets the process AUMID + registers `Software\Classes\AppUserModelId\…` so toasts show "Hindsight" with the icon instead of "Windows PowerShell" |
| Auto-update            | Tauri updater                                                                       | Built in, signed                                                                                                                                |
| Packaging              | Tauri bundler                                                                       | `.msi` + NSIS `.exe` for Windows; `.dmg` deferred (see roadmap)                                                                                 |

### Why not Electron?

Electron is a Chromium per app. For a tool that sits in the tray running 8+ hours/day on someone's work machine, that's a lot of RAM and battery. Tauri uses the OS webview (WebView2 on Windows, WKWebView on Mac), so you get a tiny native binary. The trade-off is that Rust is in the picture; we accept that because the Rust we write is small and bounded (capture loop, idle detection, tray).

## Infra

| Concern            | Choice                                                                   |
| ------------------ | ------------------------------------------------------------------------ |
| Compute            | Serverless host (Railway / Fly.io / Render — TBD when deploy plan lands) |
| Postgres           | Neon (managed, serverless)                                               |
| Redis              | Upstash (managed, serverless)                                            |
| TLS / CDN / DNS    | Cloudflare                                                               |
| Object storage     | Cloudflare R2                                                            |
| CI                 | GitHub Actions                                                           |
| Code signing (Mac) | Apple Developer ($99/yr)                                                 |
| Code signing (Win) | EV cert (~$300/yr) — non-optional for installer trust                    |
| Error tracking     | Sentry                                                                   |
| Uptime             | Better Stack or UptimeRobot                                              |

## Languages summary

- TypeScript everywhere it can be (backend, web, Tauri UI)
- Rust only inside Tauri sidecars and plugins
- SQL written via Prisma; raw SQL allowed when Prisma is awkward (rare)

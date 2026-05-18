# 11 — Glossary

Plain-English definitions for terms used across the project. When in doubt, use these.

**Activity counts** — Numeric counts of keyboard and mouse input events captured during a screenshot window. Never includes content (keys, characters, positions). See `09-privacy-and-ethics.md`.

**AUMID (AppUserModelID)** — The Windows identity string used to attribute a process's toast notifications to a named app. Hindsight registers `app.hindsight.desktop` at startup with `SetCurrentProcessExplicitAppUserModelID` plus a HKCU registry entry; without this, Windows labels toasts with the launching shell's name (e.g. "Windows PowerShell" in `tauri dev`).

**Admin** — A role within an organization. Can manage members and projects; can view all screenshots and timesheets in the org. Cannot manage billing or delete the org. See `08-auth-and-permissions.md`.

**Assignment** — The link between a project and a user, granting that user the ability to track time on the project. Stored in `project_assignments`. Carries an optional `hourlyRateCents` that the time-totals report uses for `earnedCents`.

**Baseline today seconds** — On the desktop, the seconds already tracked today on the picked project before the current Start. Fetched once at Start time from `GET /orgs/:orgId/reports/time-totals?projectId=…&from=<startOfToday>` and added to the on-screen timer so it continues from today's running total rather than resetting to 0. Cleared on Stop. See `06-desktop-app.md`.

**Blur** — A privacy feature where screenshots are gaussian-blurred during processing so admins see structure but not legible content. Configured per-project via `blurScreenshots`.

**Capability** — A specific thing a caller can do. Resolved by `can(membership, action, resource?)` against the role on a membership. See the matrix in `08-auth-and-permissions.md`.

**Capture notification** — Native OS toast titled "Hindsight / Screenshot captured" that fires after every successful capture. Replaces the originally-planned "capture flash" overlay; the OS toast is consistent across both OSes and unmistakable. Not silenceable from the app — by design, see `09-privacy-and-ethics.md`.

**Capture loop** — The desktop app's background loop that fires once per screenshot window at a randomized offset.

**Confirm** — The second step of a screenshot upload, where the desktop client tells the API the bytes are in R2 and supplies metadata. See `07-screenshot-pipeline.md`.

**Device** — One installation of the desktop app, owned by one user. A user can have multiple devices (work laptop, home laptop). Each has its own token.

**Device token** — A long-lived bearer credential issued by `POST /devices/register` and stored in the OS keychain on the user's machine. Authenticates desktop API calls. Stored as `sha256(token)` in the `tokens` table with `kind = device`; never expires by time, only by explicit revocation.

**Grace window (deletion)** — A short period after capture (default 5 minutes) during which the member who owns the screenshot can delete it from their own portal. After the window closes, only admins can delete.

**Idempotency-Key** — A header sent by the desktop app on mutating requests so retries don't double-apply. The server caches the response for the key for a short window and replays it on duplicates.

**Idle** — A state entered when the OS reports no input for longer than the project's `idleThresholdMinutes`. Tracking pauses; the user is prompted to keep, discard, or mark-as-break the idle stretch on return.

**Invitation** — A pending offer to join an org with a specific role. A unique token is emailed; acceptance creates a `membership`.

**Member** — The role with the fewest privileges in an org. Tracks time on assigned projects, sees only their own data. See `08-auth-and-permissions.md`.

**Membership** — A row linking a user to an organization with a role. The unit of "X belongs to org Y as Z."

**Monorepo** — Single repository with `apps/api`, `apps/web`, `apps/desktop`, `packages/shared`. We use pnpm workspaces.

**Outbox** — The local SQLite store on the desktop app that holds screenshots and pending updates until they sync. Survives offline periods. See `06-desktop-app.md`.

**Owner** — The role that created the org (or was promoted to it). Full powers including billing and org deletion. There must always be at least one owner per org.

**Presign** — The first step of a screenshot upload, where the API issues a short-lived URL that lets the client PUT bytes directly to R2 without going through our server.

**Processing** — The background work done after a screenshot is uploaded: thumbnail generation, optional blur, status update.

**Project** — A unit of work within an org. Members are assigned to projects; time entries are scoped to a project.

**R2** — Cloudflare's S3-compatible object storage. Hosts every screenshot we collect.

**Retention** — How long screenshots are kept before being hard-deleted. Default 65 days (covers any "current + previous month" view with a small buffer); configurable per org down to 14.

**Role** — One of `owner`, `admin`, `member`. Lives on a membership, not on a user.

**Screenshot window** — The fixed time slice (default 10 min) within which the capture loop will fire exactly once at a random offset.

**Web token** — A bearer credential used to authenticate web app requests. Issued by `POST /auth/login` or `POST /auth/signup`, stored in `localStorage` on the client and as `sha256(token)` in the `tokens` table with `kind = web`. 30-day sliding expiry; revoked on logout or password change.

**Sidecar (Tauri)** — A native (Rust) binary bundled with the Tauri app, invoked by the JS layer for OS-level work like screenshot capture.

**Time entry** — A continuous tracking session by one user on one project from one device, with a start, optional end, and accumulated active/idle seconds. The "row" of a timesheet.

**Time totals** — Aggregated tracking time per `(user, project)` over a date range, optionally with computed `earnedCents`. Exposed via `GET /orgs/:orgId/reports/time-totals`; consumed by the web app's per-project Reports tab, the org-wide Reports page, and the desktop "My time" panel.

**Tracking** — The desktop app's active state where the timer is running and screenshots are being captured.

**ULID** — The ID format we use everywhere. 26-char, sortable, URL-safe, monotonic per-millisecond.

**Web app** — The React SPA at the root domain. Same UI used by admins and members; capability checks gate what each sees.

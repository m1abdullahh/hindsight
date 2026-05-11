# 10 — Roadmap

A milestone-based plan. Weeks are nominal — they're sequencing, not deadlines.

## v0.1 — Foundations (Week 1)

**Goal:** A deployed API server that can authenticate a user and create an org.

- Repo scaffolding, monorepo layout (`apps/api`, `apps/web`, `apps/desktop`, `packages/shared`).
- Postgres on **Neon** + Redis on **Upstash** (serverless; no Docker required for dev).
- Prisma schema for: `users`, `organizations`, `memberships`, `tokens`.
- Argon2 password hashing.
- `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`.
- Serverless host (Railway/Fly.io/Render) provisioned, GitHub Actions deploy on push to `main`.
- Cloudflare DNS + TLS for the API hostname.

**Done when:** I can curl signup → login → me on the deployed URL.

## v0.2 — Members & invites (Week 2)

- Prisma: `invitations`, `audit_logs`.
- Mail provider integrated; invitation emails send.
- `GET /orgs/:orgId/members`, invitation CRUD endpoints.
- Last-owner protection in place.
- Web app skeleton: Vite + React + TanStack Router + Tailwind + shadcn.
- Web pages: signup, login, accept-invite, members list, invite member modal.

**Done when:** I can sign up, invite someone to my org, they accept, and we both see each other in the members list.

## v0.3 — Projects & assignments (Week 3)

- Prisma: `projects`, `project_assignments`.
- Project CRUD endpoints, assignment endpoints.
- Web pages: projects list, project detail, assign-members modal.
- Capability-checking hooks in the web app to gate admin-only buttons.

**Done when:** Admin creates a project, assigns members, members see only their assigned projects.

## v0.4 — Screenshot ingestion (Week 4)

- R2 bucket configured; presigning verified.
- Prisma: `time_entries`, `screenshots`, `devices`.
- Endpoints: device register, time entry start/stop, screenshot presign + confirm.
- BullMQ worker process; `process-screenshot` job stub (no thumbnailing yet).
- Manual end-to-end test with `curl` + a real PNG.

**Done when:** I can `curl` through the full upload pipeline and see a row in the DB and an object in R2.

## v0.5 — Desktop app MVP, single OS (Week 5) ✅ Windows

- Tauri scaffold, login screen, project picker, timer.
- Rust capture sidecar working on **Windows** first (pivoted from macOS — see Plan 08; the Windows install base for the pilot org was the deciding factor).
- Local SQLite outbox + upload worker.
- Tray icon with idle/tracking states.
- Successfully captures and uploads to the dev API.
- NSIS installer signed per-user; AUMID registration for branded toasts.

**Done when:** I install the Windows build, log in, pick a project, hit Start, and see screenshots in the DB tagged with the right time entry. ✅

## v0.6 — Cross-platform & idle (Week 6)

- Windows build working with the same feature set.
- Idle detection on both OSes.
- Idle prompt UI ("keep / discard / break").
- Multi-monitor capture.
- Activity counters wired to OS input hooks.

**Done when:** Both OSes build; idle is detected and prompt resolves correctly; activity counts populate.

## v0.7 — Admin dashboard (Week 7) ✅ Partial

- ✅ Worker actually generates thumbnails and applies blur.
- ✅ Web pages: project detail (Overview / Members / Screenshots / Reports tabs), org-wide Reports page.
- ✅ Screenshot grid (per-project tab) with thumbnail load and click-to-view modal for full-res.
- ✅ **Time-totals report** (hours + earned $ by user × project, "this week" / "all time" presets, by-project / by-member pivots on the org-wide view). Replaces the original "timesheet view" item — see Plan 09.
- Day/week grouping breakdown and CSV export — deferred.
- Org dashboard (today's active members, recent screenshots) and member-detail page — not yet built.

**Done when:** As admin, I can scroll through any team member's screenshots from today with thumbnails loading fast. ✅

## v0.8 — Member self-portal & polish (Week 8) ✅ Partial

- ✅ Capture visibility — replaced the planned "capture flash" overlay with a native OS toast on every screenshot (Tauri 2's notification plugin + AUMID registration on Windows so toasts show "Hindsight" with the app icon). See Plan 10.
- ✅ **"My time" panel** on the desktop project-picker — per-project totals for the signed-in user with Today / Week / All toggle.
- ✅ **Today-aware tracker timer** — the on-screen timer continues from today's accumulated time on the picked project, not from 0.
- Screenshot deletion within grace window — wired into the per-project gallery; admin override works.
- "What this app records" first-run screen — still to build.
- Settings page (change password, list devices, revoke device) — change-password and device-list pages exist; revoke flow needs polishing.
- Audit log viewer — still to build.
- ✅ Rate limiting — wired via `express-rate-limit` + `rate-limit-redis`.

**Done when:** Members have full visibility into their own data; first-run consent flow exists.

## v0.9 — Hardening & install (Week 9)

- Apple notarization for `.dmg`.
- Windows EV signing for `.msi`.
- Tauri auto-updater wired to a release manifest.
- Sentry on all three apps.
- Backup script for Postgres → R2.
- Retention worker (deletes screenshots past `retentionDays`).
- Smoke test runbook.

**Done when:** Fresh install on a clean machine works without security warnings; an update ships through and applies cleanly.

## v1.0 — Internal pilot

- Onboard one real team (5–10 people).
- Bug-fix sprints. No new features.
- Confirm screenshot volumes, R2 costs, DB sizes against estimates.

## v1.1 — Post-pilot iteration

- TOTP 2FA.
- "Download my data" export.
- Per-org privacy settings page.
- Screenshot-view audit log entries.
- A second org onboarded.

## Future (unscheduled)

- SSO (SAML / Google Workspace) — only if a serious org needs it.
- Public REST API for integrations.
- Reports v2: CSV exports, weekly email digests, day/week grouping breakdowns, activity-density charts. (Base time-totals report shipped; these are the open follow-ups.)
- Idle-time exclusion from `totalActiveSeconds` (currently equals wall-clock session duration; the `user-idle` crate is already a dep, so the data path is half-built).
- macOS desktop build — original plan was Mac-first; pivoted to Windows-first for the pilot org. Re-add when there's demand.
- A "low activity flag for review" feature is **explicitly deferred** pending an honest discussion of whether we want to build it at all (see `09-privacy-and-ethics.md`).
- Linux desktop build, if there's demand.

## Risk log

| Risk                                                         | Likelihood | Impact   | Mitigation                                                              |
| ------------------------------------------------------------ | ---------- | -------- | ----------------------------------------------------------------------- |
| Apple notarization issues delay Mac shipping                 | Medium     | High     | Start the cert dance in Week 1, not Week 9                              |
| Windows EV cert procurement is slow                          | Medium     | High     | Order during Week 1                                                     |
| Idle detection edge cases (screen lock, fast-user-switching) | High       | Medium   | Allocate buffer in Week 6; fall back to "treat as idle"                 |
| R2 outage stalls uploads                                     | Low        | Medium   | Outbox retries forever; surface a banner                                |
| Auto-update break on a release                               | Medium     | Critical | Staged rollout, kill switch in updater manifest                         |
| Privacy concern raised by a pilot user                       | Medium     | Medium   | `09-privacy-and-ethics.md` is the answer; revisit if it doesn't satisfy |

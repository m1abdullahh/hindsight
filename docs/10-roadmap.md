# 10 — Roadmap

A milestone-based plan. Weeks are nominal — they're sequencing, not deadlines.

## v0.1 — Foundations (Week 1)

**Goal:** A deployed API server that can authenticate a user and create an org.

- Repo scaffolding, monorepo layout (`apps/api`, `apps/web`, `apps/desktop`, `packages/shared`).
- Postgres + Redis via `docker-compose`.
- Prisma schema for: `users`, `organizations`, `memberships`, `sessions`.
- Argon2 password hashing.
- `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`.
- VPS provisioned, GitHub Actions deploy on push to `main`.
- Cloudflare DNS + TLS.

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

## v0.5 — Desktop app MVP, single OS (Week 5)

- Tauri scaffold, login screen, project picker, timer.
- Rust capture sidecar working on **macOS** first (one OS to limit surface).
- Local SQLite outbox + upload worker.
- Tray icon with idle/tracking states.
- Successfully captures and uploads to the dev API.

**Done when:** I install the Mac build, log in, pick a project, hit Start, and see screenshots in the DB tagged with the right time entry.

## v0.6 — Cross-platform & idle (Week 6)

- Windows build working with the same feature set.
- Idle detection on both OSes.
- Idle prompt UI ("keep / discard / break").
- Multi-monitor capture.
- Activity counters wired to OS input hooks.

**Done when:** Both OSes build; idle is detected and prompt resolves correctly; activity counts populate.

## v0.7 — Admin dashboard (Week 7)

- Worker actually generates thumbnails and applies blur.
- Web pages: org dashboard (today's active members, recent screenshots), member detail, project detail.
- Screenshot grid with date/user/project filters.
- Modal viewer for full-res screenshots.
- Timesheet view (hours by day grouped by project).

**Done when:** As admin, I can scroll through any team member's screenshots from today with thumbnails loading fast.

## v0.8 — Member self-portal & polish (Week 8)

- Member dashboard scoped to self, identical UX to admin views.
- Screenshot deletion within grace window.
- "What this app records" first-run screen.
- Settings page (change password, list devices, revoke device).
- Audit log viewer.
- Rate limiting in production.

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
- Reports: CSV exports, weekly email digests.
- A "low activity flag for review" feature is **explicitly deferred** pending an honest discussion of whether we want to build it at all (see `09-privacy-and-ethics.md`).
- Linux desktop build, if there's demand.

## Risk log

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Apple notarization issues delay Mac shipping | Medium | High | Start the cert dance in Week 1, not Week 9 |
| Windows EV cert procurement is slow | Medium | High | Order during Week 1 |
| Idle detection edge cases (screen lock, fast-user-switching) | High | Medium | Allocate buffer in Week 6; fall back to "treat as idle" |
| R2 outage stalls uploads | Low | Medium | Outbox retries forever; surface a banner |
| Auto-update break on a release | Medium | Critical | Staged rollout, kill switch in updater manifest |
| Privacy concern raised by a pilot user | Medium | Medium | `09-privacy-and-ethics.md` is the answer; revisit if it doesn't satisfy |

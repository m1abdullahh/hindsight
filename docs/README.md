# Project Documentation

This folder is the source of truth for the project's architecture, decisions, and conventions. It exists so that any new contributor — human or LLM — can read these files and have complete context to start contributing without asking foundational questions.

## What this project is

An internal screenshot-monitoring tool for tracking team work on assigned projects. Multi-tenant SaaS architecture, but used at small scale (50–500 users). Three surfaces: backend API, web app (admin + member portals), and a native Windows/Mac desktop tracker built with Tauri.

For a one-paragraph elevator pitch, see [`01-overview.md`](./01-overview.md).

## Reading order

If you're new to the project, read these in order. Each is short and self-contained.

1. [`01-overview.md`](./01-overview.md) — what we're building and why
2. [`02-glossary.md`](./02-glossary.md) — terms used everywhere (org, member, time entry, etc.)
3. [`03-architecture.md`](./03-architecture.md) — system diagram, components, data flow
4. [`04-tech-stack.md`](./04-tech-stack.md) — every technology choice and the reason for it
5. [`05-data-model.md`](./05-data-model.md) — full database schema with relationships
6. [`06-api-design.md`](./06-api-design.md) — REST conventions, endpoint catalog, auth model
7. [`07-desktop-app.md`](./07-desktop-app.md) — Tauri app architecture, capture pipeline, offline queue
8. [`08-screenshot-pipeline.md`](./08-screenshot-pipeline.md) — end-to-end flow from capture to admin view
9. [`09-auth-and-permissions.md`](./09-auth-and-permissions.md) — sessions, device tokens, role checks
10. [`10-privacy-and-ethics.md`](./10-privacy-and-ethics.md) — what we capture, what we never capture, user rights
11. [`11-conventions.md`](./11-conventions.md) — code style, naming, error handling, testing
12. [`12-environments-and-deploy.md`](./12-environments-and-deploy.md) — dev/staging/prod, secrets, deploy flow
13. [`13-roadmap.md`](./13-roadmap.md) — what's built, what's next, what's deferred
14. [`14-decisions/`](./14-decisions/) — Architecture Decision Records (ADRs)

## How to keep this folder useful

- **Edit these files when reality changes.** Stale docs are worse than no docs.
- **New big decision? Write an ADR** in `14-decisions/`. Don't bury it in code comments.
- **Keep files short.** If a doc grows past ~300 lines, split it.
- **Link, don't duplicate.** If two docs describe the same concept, one of them is wrong.

## For LLMs reading this repo

When asked to make changes, read the relevant doc first. If a change contradicts what's written here, either update the doc as part of the change or flag the contradiction in your response. Do not silently diverge from documented decisions.

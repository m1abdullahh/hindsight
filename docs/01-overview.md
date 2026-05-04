# 01 — Overview

## The product

A screenshot-based time and activity tracker for small teams. Team members install a desktop app, pick a project they're assigned to, and start a timer. While the timer runs, the app captures screenshots at randomized intervals and records lightweight activity metrics (keystroke count, mouse event count — never the actual keys). Admins review screenshots and timesheets through a web portal; members can see their own data through the same web app.

## Who uses it

- **Owners / admins** — create the org, invite people, create projects, assign people to projects, review screenshots and timesheets.
- **Members** — receive invites, install the desktop app, track time on projects they're assigned to, view their own history.

There is no concept of an external customer or end-user beyond these two roles.

## Why we're building it

Off-the-shelf tools (Hubstaff, Time Doctor, etc.) are either expensive at scale, capture more than we want, or send data to third parties we'd rather not involve. This is small enough in scope that owning it gives us full control over privacy, retention, and the exact UX our team needs.

## What's in scope (v1)

- Email/password sign-up that creates an organization
- Email-based invitations with role assignment
- Projects with per-project capture settings (interval, blur)
- Project assignments (user ↔ project)
- Native-feeling desktop tracker for Windows and macOS
- Randomized screenshot capture within a configurable window
- Activity metrics (input event counts, idle detection)
- Offline queue with eventual sync
- Admin dashboard: screenshot grid, filters, timesheets
- Member self-portal: own screenshots, own timesheets, ability to delete recent captures within a grace window
- Audit log of admin actions

## What's explicitly out of scope (v1)

- Mobile apps
- Linux desktop client
- Payroll / invoicing integrations
- Webcam capture, microphone capture, GPS, URL logging, keylogging
- Multi-org-per-user UX polish (the data model supports it; the UI assumes one org at a time)
- SSO / SAML
- Public API for third-party integrations
- Real-time live screen viewing

Items here may move into scope later — see [`13-roadmap.md`](./13-roadmap.md) — but they should not influence v1 design decisions.

## Scale assumptions

- 50–500 total users across all orgs at peak
- ~6 screenshots per active user per hour (randomized inside 10-min windows)
- Worst case ~24,000 screenshots/day, ~1–2 GB/day of image data
- Single-region deployment is fine

These numbers shape the architecture. If they change by an order of magnitude, several decisions in [`04-tech-stack.md`](./04-tech-stack.md) need to be revisited.

## Non-goals as a product

- We are not building spyware. The line we draw is in [`10-privacy-and-ethics.md`](./10-privacy-and-ethics.md) and is treated as a hard constraint, not a preference.
- We are not building something to sell. It's an internal tool. Optimize for clarity and maintenance burden, not for "enterprise-readiness."

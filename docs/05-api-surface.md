# 05 — API Surface

REST over HTTPS, JSON bodies, cookie-based sessions for the web app, bearer device tokens for the desktop app.

## Conventions

- Base path: `/api/v1`
- Content type: `application/json` unless noted
- Auth: web uses `Cookie: session=<id>`; desktop uses `Authorization: Bearer <device_token>`
- Errors: `{ "error": { "code": "string", "message": "string", "details"?: {...} } }` with appropriate HTTP status
- Pagination: cursor-based. `?limit=50&cursor=<opaque>`. Responses include `nextCursor` (or `null`)
- All mutating desktop endpoints require `Idempotency-Key: <uuid>` (replays the same response on duplicate keys)
- Tenant scoping: every URL with `:orgId` requires a membership in that org. The middleware enforces this; handlers don't need to re-check.

## Auth

```
POST   /api/v1/auth/signup
       body: { email, password, name, organizationName }
       creates: user + org + owner membership
       returns: { user, organization, sessionId } + sets cookie

POST   /api/v1/auth/login
       body: { email, password }
       returns: { user, memberships } + sets cookie

POST   /api/v1/auth/logout
       clears cookie

GET    /api/v1/auth/me
       returns: { user, memberships }

POST   /api/v1/auth/invitations/accept
       body: { token, password?, name? }
```

## Organizations

```
GET    /api/v1/orgs/:orgId
PATCH  /api/v1/orgs/:orgId             admin only

GET    /api/v1/orgs/:orgId/members
DELETE /api/v1/orgs/:orgId/members/:userId    admin only; cannot remove last owner
PATCH  /api/v1/orgs/:orgId/members/:userId    admin only; cannot demote last owner
```

## Invitations

```
GET    /api/v1/orgs/:orgId/invitations           admin only
POST   /api/v1/orgs/:orgId/invitations           admin only: { email, role }
DELETE /api/v1/orgs/:orgId/invitations/:id       admin only
```

## Projects

```
GET    /api/v1/orgs/:orgId/projects
       admin: all projects in org
       member: only projects they're assigned to

POST   /api/v1/orgs/:orgId/projects              admin only
GET    /api/v1/projects/:projectId
PATCH  /api/v1/projects/:projectId               admin only

POST   /api/v1/projects/:projectId/archive
DELETE /api/v1/projects/:projectId/archive

GET    /api/v1/projects/:projectId/assignments
POST   /api/v1/projects/:projectId/assignments   admin only
DELETE /api/v1/projects/:projectId/assignments/:userId
```

## Devices (desktop app)

```
POST   /api/v1/devices/register
       auth: session cookie
       body: { deviceName, os, appVersion }
       returns: { deviceId, deviceToken }     // shown ONCE

GET    /api/v1/devices
DELETE /api/v1/devices/:deviceId               // revokes token

POST   /api/v1/devices/heartbeat
       auth: device token
       body: { appVersion }
```

## Time entries

```
POST   /api/v1/time-entries
       auth: device token (preferred) or session
       body: { projectId, startedAt }

PATCH  /api/v1/time-entries/:id
       body (any subset): { endedAt?, totalActiveSeconds?, totalIdleSeconds?, notes? }

GET    /api/v1/orgs/:orgId/time-entries?userId=&projectId=&from=&to=
```

## Screenshots

```
POST   /api/v1/screenshots/presign
       auth: device token
       body: { timeEntryId, capturedAt, monitorIndex, contentType }
       returns: { screenshotId, putUrl, expiresAt }

POST   /api/v1/screenshots/:id/confirm
       auth: device token
       body: { width, height, activeWindowTitle?, activeApp?,
               keyboardEventsCount, mouseEventsCount, sizeBytes }

GET    /api/v1/orgs/:orgId/screenshots?userId=&projectId=&from=&to=&cursor=
       returns paginated metadata + presigned thumbnail GET URLs

GET    /api/v1/screenshots/:id
       returns metadata + presigned full-res GET URL

DELETE /api/v1/screenshots/:id
       member: only own, only within deletion grace window
       admin: always
```

## Reports

```
GET    /api/v1/orgs/:orgId/reports/timesheet?userId=&projectId=&from=&to=&groupBy=day|week|user|project
GET    /api/v1/orgs/:orgId/reports/activity?userId=&from=&to=
```

## Audit log

```
GET    /api/v1/orgs/:orgId/audit?from=&to=&actorId=&action=     admin only
```

## Rate limiting

Per-IP and per-token limits via Redis token bucket:
- Auth endpoints: 10/min/IP
- Screenshot presign: 30/min/device (well above the ~6/hour real rate, but allows backfill from offline queue)
- Everything else: 120/min/user

## Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `unauthorized` | 401 | No valid session/token |
| `forbidden` | 403 | Auth OK but caller lacks permission for this org/resource |
| `not_found` | 404 | |
| `conflict` | 409 | Unique constraint violation (e.g., duplicate email invite) |
| `invalid_input` | 422 | Body failed Zod validation |
| `rate_limited` | 429 | |
| `internal` | 500 | Unhandled |

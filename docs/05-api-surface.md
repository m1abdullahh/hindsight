# 05 — API Surface

REST over HTTPS, JSON bodies, opaque bearer tokens for both web and desktop clients.

## Conventions

- Base path: `/api/v1`
- Content type: `application/json` unless noted
- Auth: `Authorization: Bearer <token>` on every authenticated request. Web tokens and device tokens have different lifetime/revocation policies (see [`08-auth-and-permissions.md`](./08-auth-and-permissions.md)) but the same wire format.
- Errors: `{ "error": { "code": "string", "message": "string", "details"?: {...} } }` with appropriate HTTP status
- Pagination: cursor-based. `?limit=50&cursor=<opaque>`. Responses include `nextCursor` (or `null`)
- All mutating desktop endpoints require `Idempotency-Key: <uuid>` (replays the same response on duplicate keys)
- Tenant scoping: every URL with `:orgId` requires a membership in that org. The middleware enforces this; handlers don't need to re-check.

## Auth

```
POST   /api/v1/auth/signup
       body: { email, password, name, organizationName }
       creates: user + org + owner membership
       returns: { user, organization, token, expiresAt }

POST   /api/v1/auth/login
       body: { email, password }
       returns: { user, memberships, token, expiresAt }

POST   /api/v1/auth/logout
       auth: bearer token
       revokes the calling token

GET    /api/v1/auth/me
       auth: bearer token
       returns: { user, memberships }

PATCH  /api/v1/auth/me
       auth: bearer token
       body: { name? }   // at least one field required
       returns: { user, memberships }

POST   /api/v1/auth/invitations/accept
       body: { token, password?, name? }
       returns: { user, organization, memberships, token, expiresAt }
       errors:
         400 invalid_input { requires: ['password'|'name'][], existingUser: false }
              → new user is missing required fields
         400 invalid_input { requires: [], existingUser: true }
              → existing account; resubmit without password
         404 not_found  → token not valid (missing, expired, accepted, revoked)
         422 invalid_input → password is in HIBP breach list
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
       creates a new entry; auto-closes any open entry on the same device.

PATCH  /api/v1/time-entries/:id
       body (any subset): { endedAt?, totalActiveSeconds?, totalIdleSeconds?, notes? }
       constraints:
         - totalActiveSeconds / totalIdleSeconds: 0..86_400 (24h)
         - endedAt cannot be patched once the entry is already closed (409)
         - totalActiveSeconds CAN be patched on closed entries (used by the
           backfill script and by admin corrections)

GET    /api/v1/orgs/:orgId/time-entries?userId=&projectId=&from=&to=
       cursor-paginated (limit max 100, default 50)
```

**Desktop PATCH cadence (contract).** The desktop client must keep `totalActiveSeconds`
fresh so live reports stay current:

- On Start — server creates the entry with `totalActiveSeconds = 0`.
- Every 60 seconds during tracking — desktop PATCHes the running entry with the
  current elapsed seconds (`now - startedAt`). Silent on failure; the next tick
  retries. See `apps/desktop/src/screens/TrackingScreen.tsx`.
- On Stop — desktop PATCHes with `{ endedAt, totalActiveSeconds }` in one call,
  using the final elapsed value (capped at 86_400).

Today's "active" semantics match wall-clock session time. Idle exclusion is
on the roadmap; when it lands, `totalActiveSeconds` will subtract idle and
`totalIdleSeconds` will be populated independently.

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
GET    /api/v1/orgs/:orgId/reports/time-totals?userId=&projectId=&from=&to=
       auth: web bearer; org-scoped via membership.
       returns:
         {
           rows: [
             {
               userId, userName, userEmail,
               projectId, projectName,
               totalActiveSeconds,        // SUM over time_entries in range
               hourlyRateCents,           // from project_assignments; null if no rate
               earnedCents                // round(seconds/3600 * rateCents); null if no rate
             }, ...
           ],
           range: { from: ISO|null, to: ISO|null }
         }
       scoping:
         - role=member: userId filter is silently forced to caller.userId
           (any value passed in the query string is ignored).
         - role=admin|owner: userId optional; omit for all members.
       aggregation runs in Postgres via prisma.timeEntry.groupBy by
       (userId, projectId). Rows are sorted by (projectName, userName).
       No pagination — typical orgs return <1000 rows. Revisit if a real
       org pushes past 10k.
```

**Not yet shipped (still planned):**

```
GET    /api/v1/orgs/:orgId/reports/timesheet?...&groupBy=day|week
GET    /api/v1/orgs/:orgId/reports/activity?userId=&from=&to=
```

Day/week grouping and activity-density reports were carved out of the
time-totals plan and are deferred. CSV export is also deferred.

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

| Code            | HTTP | Meaning                                                    |
| --------------- | ---- | ---------------------------------------------------------- |
| `unauthorized`  | 401  | No valid session/token                                     |
| `forbidden`     | 403  | Auth OK but caller lacks permission for this org/resource  |
| `not_found`     | 404  |                                                            |
| `conflict`      | 409  | Unique constraint violation (e.g., duplicate email invite) |
| `invalid_input` | 422  | Body failed Zod validation                                 |
| `rate_limited`  | 429  |                                                            |
| `internal`      | 500  | Unhandled                                                  |

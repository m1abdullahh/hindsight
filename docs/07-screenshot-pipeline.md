# 07 — Screenshot Pipeline

End-to-end: from the user's screen to bytes in R2 to a thumbnail an admin sees.

## Stages

```
[Capture]→[Local SQLite outbox]→[Presign]→[Direct PUT to R2]
                                                 │
                                                 ▼
                                        [Confirm + enqueue job]
                                                 │
                                                 ▼
                                  [Worker: thumbnail (+ blur)]
                                                 │
                                                 ▼
                                       [Status: processed]
                                                 │
                                                 ▼
                              [Admin/member views via presigned GET]
```

## Capture (desktop)

- Triggered by the capture loop (see `06-desktop-app.md`).
- Output: a JPEG (quality 75, configurable). At ~1080p that's ~150–250 KB; multi-monitor setups multiply by monitor count.
- Bytes plus metadata (capture time, monitor index, active window title, active app, keyboard/mouse counts, dimensions) go into the local outbox row.

## Outbox + retry (desktop)

- The upload worker runs continuously while the app is running, on its own task.
- Order: oldest first.
- One concurrent upload at a time per device (don't saturate the user's uplink).
- Backoff schedule on failure: 1m → 5m → 30m → 2h → 6h, then 24h cap, forever. Never drop.

## Presign (server)

`POST /screenshots/presign` does:

1. Authenticate device token; resolve `userId`, `orgId`.
2. Validate `timeEntryId` belongs to this user and is open (or just-closed within a small grace window).
3. Validate `capturedAt` is within sane bounds (not more than 7 days old, not in the future beyond a small skew).
4. Insert a `screenshots` row with `status = pending`, generated `id`, computed `s3Key`.
5. Generate a presigned PUT URL valid for 5 minutes, restricted to:
   - Specific key
   - Content-Type matching the request
   - Max size (e.g., 8 MB)
6. Return `{ screenshotId, putUrl, expiresAt }`.

S3 key format:
```
orgs/{orgId}/users/{userId}/{yyyy}/{mm}/{dd}/{screenshotId}.jpg
```

This makes lifecycle rules and retention sweeps trivial by date prefix.

## Direct upload to R2

- Client PUTs bytes to the presigned URL.
- On 2xx, client moves to confirm.
- On 4xx, client logs and treats as a permanent error for *that presign* — gets a fresh URL on next attempt.
- On 5xx or network error, client retries with backoff.

## Confirm (server)

`POST /screenshots/:id/confirm` does:

1. Authenticate; verify the screenshot belongs to this device.
2. Update row: `status = uploaded`, store `width`, `height`, `activeWindowTitle`, `activeApp`, `keyboardEventsCount`, `mouseEventsCount`, `sizeBytes`.
3. Enqueue BullMQ job `process-screenshot` with `screenshotId`.
4. Return updated row.

## Processing job (worker)

The `process-screenshot` worker:

1. Fetches the row and the original object from R2.
2. Generates a thumbnail with `sharp`:
   - Max dimension 480px on the long side
   - JPEG quality 70
   - PUT to `…/{id}-thumb.jpg`
3. If the project has `blurScreenshots = true`:
   - Apply a strong gaussian blur (`sharp().blur(20)`) to *both* a "blurred full" (`{id}-blur.jpg`) and the thumbnail.
   - Original is retained until the next retention sweep, and only admins with an unblur permission flag can view the original (controlled in policy; default no-one).
4. Update the row: `thumbnailS3Key`, `blurred`, `status = processed`.
5. On failure, retry up to 5 times with backoff. After that, set `status = failed` and emit an alert.

## Reading screenshots

- List endpoint returns metadata + presigned GET URLs for thumbnails. Presigned URLs are valid for ~10 minutes; the client refetches the page when they're stale.
- Full-resolution view is a separate endpoint that issues a fresh presigned GET URL for the original (or blurred) object.
- Browsers fetch images directly from R2 with no extra hop through our API.

## Soft delete + retention

- `DELETE /screenshots/:id` sets `deleted_at`. A nightly worker:
  1. Lists screenshots with `deleted_at < now() - 7 days` OR `created_at < now() - retentionDays`.
  2. Deletes original + thumbnail + blurred objects from R2.
  3. Hard-deletes rows.
- A separate weekly worker walks R2 prefixes and reconciles orphans (objects with no matching DB row) — defensive cleanup.

## Failure modes and what we do about them

| Failure | What happens | Mitigation |
|---|---|---|
| Network down on user's machine | Outbox grows | Bounded only by disk; soft warning at 1 GB |
| Presign returns 401 (expired device token) | Worker pauses, surfaces "please re-login" | UX prompt, retry on relogin |
| R2 PUT 5xx | Backoff and retry | Standard retry schedule |
| Confirm fails after successful PUT | Row stuck `pending`; reconciliation job sees orphan in R2 | Reconciler links/cleans on schedule |
| Worker can't read object during processing | Row stuck `uploaded` | Worker retries; alert after N failures |
| Disk full on server | Workers fail | Out of scope for this design; ops monitor disk |

## What we don't do

- **No image hashing for dedup.** Captures are unique enough; we'd save little and complicate the pipeline.
- **No OCR.** Tempting but a privacy minefield. If we ever add it, it's opt-in per project and clearly disclosed.
- **No client-side encryption.** Adds key management for marginal benefit on an internal tool. Revisit if requirements change.

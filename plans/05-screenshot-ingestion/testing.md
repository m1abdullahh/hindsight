# Screenshot Ingestion — Testing

The hardest part of testing this plan: not hitting real R2 in CI. Three principles:

1. **Stub R2 in integration tests.** A drop-in provider that captures keys + buffers in memory, returns presigned URLs that look real but resolve to nothing. Same swap mechanism as the mail stub from Plan 03.
2. **Test the worker directly.** Don't run BullMQ; call `process(job)` with a fake job object. Asserts state transitions and R2 stub interactions.
3. **Save a real bucket for manual smoke.** The done-when criteria require a real `curl` end-to-end with R2; that lives outside the automated test suite.

## R2 stub provider

```ts
// test/helpers/r2-stub.ts
import type { Buffer } from 'node:buffer';

import { __setR2Provider } from '../../src/lib/r2.js';

interface StubObject {
  bytes: Buffer;
  contentType: string;
}

class StubR2 {
  readonly objects = new Map<string, StubObject>();
  readonly putUrls: Array<{ key: string; contentType: string; expiresAt: Date }> = [];
  readonly getUrls: Array<{ key: string; expiresAt: Date }> = [];

  put(key: string, bytes: Buffer, contentType: string): void {
    this.objects.set(key, { bytes, contentType });
  }

  reset(): void {
    this.objects.clear();
    this.putUrls.length = 0;
    this.getUrls.length = 0;
  }
}

export const r2Stub = new StubR2();

export const installR2Stub = (): void => {
  __setR2Provider({
    // The lazy module exposes its functions; wire them to capture in-memory.
    // (Implementation detail: the stub has the same shape r2.ts expects.)
    presignPut: async (key, contentType, _maxSize) => {
      const url = `https://stub.r2/put/${encodeURIComponent(key)}?ct=${contentType}`;
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      r2Stub.putUrls.push({ key, contentType, expiresAt });
      return { putUrl: url, expiresAt, key };
    },
    presignGetThumbnail: async (key) => {
      const url = `https://stub.r2/get/${encodeURIComponent(key)}`;
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      r2Stub.getUrls.push({ key, expiresAt });
      return { url, expiresAt };
    },
    presignGetFull: async (key) => {
      const url = `https://stub.r2/get-full/${encodeURIComponent(key)}`;
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      r2Stub.getUrls.push({ key, expiresAt });
      return { url, expiresAt };
    },
    deleteObject: async (key) => {
      r2Stub.objects.delete(key);
    },
    headObject: async (key) => {
      const obj = r2Stub.objects.get(key);
      return obj ? { size: obj.bytes.length } : null;
    },
    getObjectBytes: async (key) => {
      const obj = r2Stub.objects.get(key);
      if (!obj) throw new Error(`stub r2: missing object ${key}`);
      return obj.bytes;
    },
    putObjectBytes: async (key, bytes, contentType) => {
      r2Stub.objects.set(key, { bytes, contentType });
    },
  });
};
```

The exact provider shape matches what [r2.md](./r2.md) exports. The `__setR2Provider` test seam from `r2.ts` accepts the stub.

`test/setup.ts` calls `installR2Stub()` once. `beforeEach` in tests that use it calls `r2Stub.reset()`.

## Testing presign + confirm flow without real bytes

The integration test "uploads" by directly inserting bytes into the stub _as if_ the desktop had PUT them:

```ts
// 1. Presign — stores PUT URL in r2Stub.putUrls.
const presigned = await request(app)
  .post('/api/v1/screenshots/presign')
  .set('Authorization', `Bearer ${deviceToken}`)
  .set('Idempotency-Key', randomUUID())
  .send({ timeEntryId, capturedAt, monitorIndex: 0, contentType: 'image/jpeg' });

// 2. Simulate the desktop PUT by writing to the stub directly.
const expectedKey = r2Stub.putUrls.at(-1)!.key;
r2Stub.put(expectedKey, Buffer.from(makePngPixel()), 'image/jpeg');

// 3. Confirm.
const confirm = await request(app)
  .post(`/api/v1/screenshots/${presigned.body.screenshotId}/confirm`)
  .set('Authorization', `Bearer ${deviceToken}`)
  .set('Idempotency-Key', randomUUID())
  .send({ width: 1, height: 1, sizeBytes: bytes.length, ... });
```

`makePngPixel()` returns a 1×1 JPEG (or PNG) in a few bytes — enough for `sharp` to chew on without inflating the test fixture file.

## Test files

Five new files. The truncate-list update from [schema.md](./schema.md#truncateall-helper-update) lands as part of step 2.

- `test/devices.test.ts` — register / list / heartbeat / revoke
- `test/time-entries.test.ts` — create / patch / list, role-based filtering
- `test/screenshots.test.ts` — presign / confirm / list / get / delete (with R2 stub)
- `test/process-screenshot.test.ts` — direct call to `process(job)`, asserts state transitions
- `src/lib/r2.test.ts` — unit tests of `r2.ts` itself with `@aws-sdk/client-s3` mocked

## `test/devices.test.ts`

Happy paths:

- **Register:** signup → `POST /devices/register` with Idempotency-Key → 201 with `{ deviceId, deviceToken }`. Token authenticates `GET /devices`.
- **Idempotent register:** same Idempotency-Key replays the **same** response (DB has one device, response identical).
- **List:** owner of multiple devices sees them all sorted by `lastSeenAt`.
- **Heartbeat:** updates `lastSeenAt` and `appVersion`.
- **Revoke (own):** user revokes their own device → 204; subsequent device-token request returns 401.
- **Revoke (admin):** admin in same org as the device's user revokes a stolen laptop → 204; audit `device.revoked` written.

Edge cases:

- **Register with device token** (instead of web token) → 403.
- **Heartbeat with web token** → 403.
- **Revoke someone else's device when not admin** → 403.
- **Audit:** `device.registered` written on register; `device.revoked` written on revoke.

## `test/time-entries.test.ts`

Setup: signup + register-device + create-project + assign-member + start.

Happy paths:

- **Start:** member with assignment → 201 with `{ id, startedAt, endedAt: null }`.
- **Auto-stop on second start:** start one, start another with the same device — first is auto-closed (`endedAt` set on first row); second returns the new entry.
- **Patch end:** PATCH with `{ endedAt }` → 200 with updated row.
- **Patch counters:** PATCH with `{ totalActiveSeconds, totalIdleSeconds }` → values stored.
- **List (admin):** sees all entries in the org.
- **List (member):** sees only their own, even when the query asks for `userId = someone-else`.

Edge cases:

- **Start on a project the user isn't assigned to (and they're a member, not admin)** → 403.
- **Start with `startedAt` 8 days in the past** → 422.
- **Start with `startedAt` 5 minutes in the future** → 422.
- **Patch with empty body** → 422.
- **Patch a closed entry's `endedAt`** → 409.
- **Patch entry owned by another user (without admin)** → 403.

## `test/screenshots.test.ts`

Setup: full chain — signup + register-device + project + assignment + start.

Happy paths:

- **Presign:** device + valid time entry → 201 with `{ screenshotId, putUrl, expiresAt }`. DB row has `status: 'pending'`.
- **Idempotent presign:** same Idempotency-Key replays. **Same** screenshotId, **same** putUrl.
- **Confirm:** PUT bytes to stub → confirm → 200 with `status: 'uploaded'`. Job enqueued (assert by reading the BullMQ queue length).
- **Confirm without R2 object:** stub doesn't have the key → confirm returns 422.
- **Re-confirm same id:** returns the same row, doesn't re-enqueue.
- **List (admin):** sees the row, with thumbnail URL `null` until processed.
- **List (member):** sees only own rows.
- **Get:** returns full URL (presigned).
- **Delete (own, within grace):** 204; subsequent get returns 404.
- **Delete (own, outside grace):** 403.
- **Delete (admin, any):** 204.

Edge cases:

- **Presign with web token** → 403.
- **Presign with someone else's time entry** → 403.
- **Presign for a closed time entry > 5 min old** → 422.
- **Presign with `image/gif`** → 422.
- **Presign for `capturedAt` 8 days old** → 422.
- **Audit:** `screenshot.deleted` row written on delete.
- **Cross-org:** user in org B cannot read screenshots in org A.

## `test/process-screenshot.test.ts`

Direct call to the worker's `process(job)` function — no BullMQ.

Setup helper that creates a screenshot row in `uploaded` state with the original bytes already in the R2 stub.

Cases:

- **Happy path (no blur):** project has `blurScreenshots: false`. After `process()`, the row has `status: 'processed'`, `thumbnailS3Key` set, `blurredS3Key: null`. R2 stub contains a thumbnail object at the expected key with `image/webp` content type.
- **Happy path (with blur):** project has `blurScreenshots: true`. After `process()`, both `thumbnailS3Key` and `blurredS3Key` are set; both objects exist in the stub.
- **Idempotent (already processed):** call `process()` on a row that's already `processed`. No new R2 writes; row unchanged.
- **Missing original:** R2 stub doesn't have the key. `process()` throws (BullMQ would retry); we assert the throw and the row stays `uploaded`.
- **Pending row:** `process()` short-circuits (logs warning, returns).

Asserting "thumbnail looks right" is **not** a test concern — sharp is sharp's problem. We assert the _flow_: object exists at the expected key, content type is `image/webp`, size is non-zero.

## `src/lib/r2.test.ts`

Unit tests of the `r2.ts` helpers themselves. Mock `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`.

- **Lazy init**: calling `presignPut` with no R2 env vars throws `AppError('r2_unavailable', 503, ...)`.
- **`originalKey` / `thumbnailKey` / `blurredKey`**: assert format for known inputs (no time zones, UTC date math).
- **`getObjectBytes`**: chunks an `AsyncIterable<Uint8Array>` into a single `Buffer`.

These run in milliseconds and prove our wrappers do what they say.

## What we explicitly don't test

- **Real R2.** Done manually per the README's done-when criteria.
- **`sharp` output quality.** We assert it produced a webp; we don't visually inspect.
- **BullMQ retries.** The retry policy is configuration; the test that matters is "process is idempotent on rerun."
- **Concurrency stress** (50 simultaneous uploads). Out of scope for v0.4 verification.

## Test suite size estimate

- Capability matrix: no new rows (`screenshots:read` and `screenshots:delete` already covered in Plan 04 tests).
- Devices: ~7–8 integration tests
- Time entries: ~10 integration tests
- Screenshots: ~12 integration tests
- Worker: ~5 unit-ish tests
- R2 helpers: ~5 unit tests

Total: ~40 new tests, bringing the suite to ~145.

## Performance note

Integration tests on Neon's pooled compute take ~3–10s per test for cold starts. With 40 new tests added serially (because of `fileParallelism: false`), expect ~10–15 minutes for a full `pnpm test` run after this plan lands. Acceptable for now; if it hurts, switch to `singleFork: true` + isolated db transactions per test.

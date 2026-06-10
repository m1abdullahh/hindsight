import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emit } from '@tauri-apps/api/event';

import { ApiError, apiDelete, clearTokenCache } from './api';
import { session } from './session-store';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue('device-token'),
}));

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./session-store', () => ({
  session: { getState: vi.fn() },
}));

const emitMock = vi.mocked(emit);
const getState = vi.mocked(session.getState);

/** Build a fake non-OK Response carrying an API error envelope. */
function errorResponse(status: number, code: string, message: string): Response {
  return {
    ok: false,
    status,
    statusText: '',
    json: () => Promise.resolve({ error: { code, message } }),
  } as unknown as Response;
}

const reauthCalls = () =>
  emitMock.mock.calls.filter(([event]) => event === 'reauth-required').length;

describe('api auth-failure handling', () => {
  beforeEach(() => {
    clearTokenCache();
    emitMock.mockClear();
    // Past boot: a 401 here is a genuine mid-session revocation.
    getState.mockReturnValue({ stage: 'tracking' } as ReturnType<typeof session.getState>);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does NOT sign the user out on a 403 (authorization denial)', async () => {
    // This is the "delete a screenshot you can't delete from the Me tab" path.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errorResponse(403, 'forbidden', 'cannot delete this screenshot')),
    );

    await expect(apiDelete('/screenshots/abc')).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    await expect(apiDelete('/screenshots/abc')).rejects.toBeInstanceOf(ApiError);

    expect(reauthCalls()).toBe(0);
  });

  it('DOES sign the user out on a 401 (dead session)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errorResponse(401, 'unauthorized', 'token revoked')),
    );

    await expect(apiDelete('/screenshots/abc')).rejects.toMatchObject({ status: 401 });

    expect(reauthCalls()).toBe(1);
    expect(emitMock).toHaveBeenCalledWith('reauth-required', { reason: 'api 401' });
  });

  it('suppresses reauth on a 401 during boot (stage === "login")', async () => {
    getState.mockReturnValue({ stage: 'login' } as ReturnType<typeof session.getState>);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errorResponse(401, 'unauthorized', 'token expired')),
    );

    await expect(apiDelete('/screenshots/abc')).rejects.toMatchObject({ status: 401 });

    expect(reauthCalls()).toBe(0);
  });
});

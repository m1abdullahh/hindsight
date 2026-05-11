import { invoke } from '@tauri-apps/api/core';

declare const __API_BASE_URL__: string;

let cachedToken: string | null = null;

async function getToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  cachedToken = await invoke<string | null>('get_device_token');
  return cachedToken;
}

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
  /** Override the cached token (used during the login → register handoff). */
  tokenOverride?: string | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const url = `${__API_BASE_URL__}/api/v1${path}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = opts.tokenOverride !== undefined ? opts.tokenOverride : await getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers,
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  const res = await fetch(url, init);
  if (res.status === 204) return undefined as T;

  if (!res.ok) {
    let code = 'internal';
    let message = res.statusText || `HTTP ${res.status}`;
    let details: unknown;
    try {
      const body = await res.json();
      if (body?.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
        details = body.error.details;
      }
    } catch {
      // Non-JSON body — keep the status text.
    }
    throw new ApiError(res.status, code, message, details);
  }

  return (await res.json()) as T;
}

export const apiGet = <T>(path: string, tokenOverride?: string) =>
  api<T>(path, tokenOverride !== undefined ? { method: 'GET', tokenOverride } : { method: 'GET' });

export const apiPost = <T>(
  path: string,
  body?: unknown,
  idempotencyKey?: string,
  tokenOverride?: string,
) => {
  const opts: ApiOptions = { method: 'POST' };
  if (body !== undefined) opts.body = body;
  if (idempotencyKey) opts.idempotencyKey = idempotencyKey;
  if (tokenOverride !== undefined) opts.tokenOverride = tokenOverride;
  return api<T>(path, opts);
};

export const apiPatch = <T>(path: string, body: unknown, idempotencyKey?: string) => {
  const opts: ApiOptions = { method: 'PATCH', body };
  if (idempotencyKey) opts.idempotencyKey = idempotencyKey;
  return api<T>(path, opts);
};

export const clearTokenCache = () => {
  cachedToken = null;
};

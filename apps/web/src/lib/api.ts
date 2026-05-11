import type { ErrorBody, ErrorCode } from '@hindsight/shared/dto';

import { sessionStore } from './session-store';

const BASE_URL = import.meta.env['VITE_API_BASE_URL'] ?? '';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;
  readonly retryAfter: number | undefined;

  constructor(status: number, body: ErrorBody, retryAfter?: number) {
    super(body.error.message);
    this.name = 'ApiError';
    this.code = body.error.code;
    this.status = status;
    this.details = body.error.details;
    this.retryAfter = retryAfter;
  }
}

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  idempotencyKey?: string;
  swallow401?: boolean;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const url = new URL(`${BASE_URL}/api/v1${path}`, window.location.origin);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = sessionStore.getState().token;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers,
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  const res = await fetch(url.toString(), init);

  if (res.status === 204) return undefined as T;

  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    let body: ErrorBody;
    if (contentType.includes('application/json')) {
      body = (await res.json()) as ErrorBody;
    } else {
      body = {
        error: {
          code: 'internal',
          message: res.statusText || `HTTP ${res.status}`,
        },
      };
    }

    const retryAfterHeader = res.headers.get('Retry-After');
    const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : undefined;

    if (res.status === 401 && !opts.swallow401) {
      sessionStore.getState().clearSession();
    }

    throw new ApiError(res.status, body, Number.isFinite(retryAfter) ? retryAfter : undefined);
  }

  return (await res.json()) as T;
}

export const apiGet = <T>(path: string, query?: ApiOptions['query']) =>
  api<T>(path, query !== undefined ? { method: 'GET', query } : { method: 'GET' });

export const apiPost = <T>(path: string, body?: unknown) =>
  api<T>(path, body !== undefined ? { method: 'POST', body } : { method: 'POST' });

export const apiPatch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });

export const apiDelete = <T>(path: string) => api<T>(path, { method: 'DELETE' });

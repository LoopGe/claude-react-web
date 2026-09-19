// Thin API wrapper. Delegates to the active Transport (web: fetch against
// /api; desktop: IPC) so callers are indifferent to the wire. All requests
// have a default 30 s timeout to prevent the UI from hanging indefinitely
// when the backend is unresponsive.

import { getTransport, type TransportRequestOptions } from '../transport'

export type { ApiError } from '../transport/types'

export function apiRequest<T>(
  path: string,
  init: RequestInit = {},
  opts: TransportRequestOptions = {},
): Promise<T> {
  return getTransport().request<T>(path, init, opts)
}

export const api = {
  get: <T>(path: string, opts?: { signal?: AbortSignal; timeoutMs?: number }) =>
    apiRequest<T>(path, { signal: opts?.signal }, { timeoutMs: opts?.timeoutMs }),
  post: <T>(path: string, body?: unknown, opts?: { signal?: AbortSignal; timeoutMs?: number }) =>
    apiRequest<T>(
      path,
      { method: 'POST', body: body == null ? undefined : JSON.stringify(body), signal: opts?.signal },
      { timeoutMs: opts?.timeoutMs },
    ),
  put: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: 'PUT', body: body == null ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: 'PATCH', body: body == null ? undefined : JSON.stringify(body) }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
}

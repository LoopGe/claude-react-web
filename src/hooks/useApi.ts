// Tiny fetch wrapper. Uses /api as the base path (Vite proxies in dev, same-origin in prod).

export interface ApiError extends Error {
  status: number
}

function toApiError(res: Response, body: unknown): ApiError {
  const message =
    (body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `HTTP ${res.status}`) || `HTTP ${res.status}`
  const err = new Error(message) as ApiError
  err.status = res.status
  return err
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const contentType = res.headers.get('content-type') ?? ''
  const body = contentType.includes('application/json') ? await res.json() : await res.text()
  if (!res.ok) throw toApiError(res, body)
  return body as T
}

export const api = {
  get: <T>(path: string) => apiRequest<T>(path),
  post: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: 'POST', body: body == null ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: 'PATCH', body: body == null ? undefined : JSON.stringify(body) }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
}

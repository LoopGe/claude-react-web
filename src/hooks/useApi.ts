// Tiny fetch wrapper. Uses /api as the base path (Vite proxies in dev, same-origin in prod).
// All requests have a default 30 s timeout to prevent the UI from hanging indefinitely
// when the backend is unresponsive.

export interface ApiError extends Error {
  status: number
}

const DEFAULT_TIMEOUT_MS = 30_000

function toApiError(res: Response, body: unknown): ApiError {
  const validationErrors = body && typeof body === 'object' && 'errors' in body && Array.isArray((body as { errors: unknown }).errors)
    ? (body as { errors: unknown[] }).errors
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const path = 'path' in item && typeof (item as { path: unknown }).path === 'string'
          ? (item as { path: string }).path
          : ''
        const message = 'message' in item && typeof (item as { message: unknown }).message === 'string'
          ? (item as { message: string }).message
          : ''
        return `${path} ${message}`.trim()
      })
      .filter((item): item is string => typeof item === 'string' && item.length > 0)
      .join('; ')
    : ''
  const message =
    (body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
      ? (body as { error: string }).error
      : validationErrors
        ? validationErrors
      : `HTTP ${res.status}`) || `HTTP ${res.status}`
  const err = new Error(message) as ApiError
  err.status = res.status
  return err
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  // Merge caller-supplied signal with our timeout signal. When either
  // fires the request is aborted.
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs)

  // If the caller already provided a signal, propagate its abort to our
  // controller so either source can cancel the fetch.
  const callerSignal = init.signal
  let callerAbort: (() => void) | undefined
  if (callerSignal) {
    if (callerSignal.aborted) {
      timeoutController.abort(callerSignal.reason)
    } else {
      callerAbort = () => timeoutController.abort(callerSignal.reason)
      callerSignal.addEventListener('abort', callerAbort, { once: true })
    }
  }

  try {
    const res = await fetch(`/api${path}`, {
      ...init,
      signal: timeoutController.signal,
      headers: {
        // Only set Content-Type when a body is present. GET/DELETE
        // requests have no body and the header is meaningless there;
        // some proxies / CDNs treat it as a CORS preflight trigger.
        ...(init.body != null ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    })
    const contentType = res.headers.get('content-type') ?? ''
    const body = contentType.includes('application/json') ? await res.json() : await res.text()
    if (!res.ok) throw toApiError(res, body)
    return body as T
  } catch (err) {
    // Use duck-typing instead of instanceof checks: DOMException may not
    // inherit from Error in every test/browser runtime, and DOMException can
    // be undefined in some environments.
    if (err && typeof err === 'object' && 'name' in err && err.name === 'AbortError') {
      const reason = callerSignal?.aborted
        ? 'Request cancelled'
        : `Request timed out after ${timeoutMs / 1000}s`
      const timeoutErr = new Error(reason) as ApiError
      if (callerSignal?.aborted) timeoutErr.name = 'AbortError'
      timeoutErr.status = 0
      throw timeoutErr
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
    if (callerSignal && callerAbort) {
      callerSignal.removeEventListener('abort', callerAbort)
    }
  }
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

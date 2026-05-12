// Tiny fetch wrapper. Uses /api as the base path (Vite proxies in dev, same-origin in prod).
// All requests have a default 30 s timeout to prevent the UI from hanging indefinitely
// when the backend is unresponsive.

export interface ApiError extends Error {
  status: number
}

const DEFAULT_TIMEOUT_MS = 30_000

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
  // Merge caller-supplied signal with our timeout signal. When either
  // fires the request is aborted.
  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => timeoutController.abort(), DEFAULT_TIMEOUT_MS)

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
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
    const contentType = res.headers.get('content-type') ?? ''
    const body = contentType.includes('application/json') ? await res.json() : await res.text()
    if (!res.ok) throw toApiError(res, body)
    return body as T
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      const reason = callerSignal?.aborted
        ? 'Request cancelled'
        : `Request timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`
      const timeoutErr = new Error(reason) as ApiError
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
  get: <T>(path: string, opts?: { signal?: AbortSignal }) =>
    apiRequest<T>(path, { signal: opts?.signal }),
  post: <T>(path: string, body?: unknown, opts?: { signal?: AbortSignal }) =>
    apiRequest<T>(path, { method: 'POST', body: body == null ? undefined : JSON.stringify(body), signal: opts?.signal }),
  put: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: 'PUT', body: body == null ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: 'PATCH', body: body == null ? undefined : JSON.stringify(body) }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
}

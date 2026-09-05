// api.ts — the single place that talks to the backend.
//
// Three things happen here that would otherwise be repeated on every screen:
//
//   1. The access token is attached, from memory
//   2. `credentials: 'include'` sends the refresh cookie
//   3. A 401 triggers ONE silent refresh, then retries the original request
//
// Point 3 is what makes a 15-minute access token invisible to the user.

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'

/**
 * The access token lives in a module variable — NOT localStorage.
 *
 * localStorage is readable by any JavaScript on the page, so a single XSS bug
 * (a dependency, an unescaped invoice description) hands an attacker a
 * working token. A module variable is not reachable that way.
 *
 * The cost: a page refresh loses it. That is why the app calls refresh() on
 * mount — the httpOnly cookie survives the reload, and page JavaScript cannot
 * read that one either.
 */
let accessToken: string | null = null

export function setAccessToken(token: string | null): void {
  accessToken = token
}

export function getAccessToken(): string | null {
  return accessToken
}

/** The error shape the backend returns for everything. */
export type ApiErrorBody = {
  error: {
    code: string
    message: string
    requestId: string
    details?: unknown
  }
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId: string
  readonly details: unknown

  constructor(status: number, body: ApiErrorBody) {
    super(body.error.message)
    this.name = 'ApiError'
    this.status = status
    this.code = body.error.code
    this.requestId = body.error.requestId
    this.details = body.error.details
  }

  /** Field-level messages from a Zod failure, for showing next to inputs. */
  get fieldErrors(): Array<{ field: string; message: string }> {
    if (this.code !== 'VALIDATION_ERROR' || !Array.isArray(this.details)) return []
    return this.details as Array<{ field: string; message: string }>
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  /** Internal: set on the retry so one failure cannot loop forever. */
  isRetry?: boolean
}

/**
 * Only ONE refresh runs at a time.
 *
 * When a token expires, every in-flight request 401s at roughly the same
 * moment. Without this, five parallel requests would fire five refreshes —
 * and because refresh tokens ROTATE, the first would succeed and the rest
 * would present an already-spent token. That is our own theft detection,
 * which would revoke the whole family and log the user out.
 *
 * So the first 401 starts a refresh and the others await the same promise.
 */
let refreshPromise: Promise<boolean> | null = null

async function refreshAccessToken(): Promise<boolean> {
  refreshPromise ??= (async () => {
    try {
      const response = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        // Without this the browser silently omits the cookie and refresh
        // always fails, with nothing in the console to explain why.
        credentials: 'include'
      })

      if (!response.ok) {
        setAccessToken(null)
        return false
      }

      const data = (await response.json()) as { accessToken: string }
      setAccessToken(data.accessToken)
      return true
    } catch {
      setAccessToken(null)
      return false
    } finally {
      // Cleared regardless, so the next 401 starts a fresh attempt rather
      // than awaiting a promise that already settled.
      refreshPromise = null
    }
  })()

  return refreshPromise
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {}

  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
  }
  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`
  }

  const response = await fetch(`${API_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    credentials: 'include',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {})
  })

  // ── The silent refresh ───────────────────────────────────────
  // A 401 means the access token expired or was revoked. Try once to get a
  // new one and replay the request; the user sees nothing.
  //
  // `isRetry` stops an infinite loop when the refresh itself is what is
  // failing — a revoked family, or a logged-out session.
  if (response.status === 401 && !options.isRetry && path !== '/auth/refresh') {
    const refreshed = await refreshAccessToken()
    if (refreshed) {
      return request<T>(path, { ...options, isRetry: true })
    }
  }

  if (response.status === 204) {
    return undefined as T
  }

  const text = await response.text()
  const data: unknown = text ? JSON.parse(text) : null

  if (!response.ok) {
    throw new ApiError(response.status, data as ApiErrorBody)
  }

  return data as T
}

/**
 * Fetches a binary response — used for the invoice PDF.
 *
 * A plain <a href="/invoices/x/pdf"> cannot work here: the access token
 * lives in memory and a link click sends no Authorization header. So the
 * bytes are fetched with the token, wrapped in a Blob, and handed to the
 * browser as an object URL. The one-shot refresh on 401 is reused.
 */
async function requestBlob(path: string, isRetry = false): Promise<Blob> {
  const headers: Record<string, string> = {}
  if (accessToken) headers.authorization = `Bearer ${accessToken}`

  const response = await fetch(`${API_URL}${path}`, { headers, credentials: 'include' })

  if (response.status === 401 && !isRetry) {
    const refreshed = await refreshAccessToken()
    if (refreshed) return requestBlob(path, true)
  }

  if (!response.ok) {
    const text = await response.text()
    const data: unknown = text ? JSON.parse(text) : null
    throw new ApiError(response.status, data as ApiErrorBody)
  }

  return response.blob()
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  getBlob: requestBlob,
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  /** Exposed so the app can attempt a refresh on mount. */
  refresh: refreshAccessToken
}

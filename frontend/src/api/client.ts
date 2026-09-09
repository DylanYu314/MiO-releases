import { getAccessKey } from './accessKey'
import { getInstallId } from './installId'

/** Base path for API calls. Vite proxies /api to the backend in dev (see vite.config.ts). */
const API_BASE = '/api'

export class ApiError extends Error {
  // Declared explicitly rather than as a constructor parameter property, which
  // tsconfig's erasableSyntaxOnly disallows (it would emit runtime code).
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** Pull a human-readable message out of FastAPI's error response shapes. */
async function errorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json()
    const detail = body?.detail
    if (typeof detail === 'string') return detail
    // Validation errors come back as a list of {loc, msg, type} objects.
    if (Array.isArray(detail) && detail[0]?.msg) return detail.map((d) => d.msg).join(', ')
  } catch {
    // Response wasn't JSON — fall through to the generic message.
  }
  return `Request failed with status ${response.status}`
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const accessKey = getAccessKey()
  const installId = getInstallId()
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      // Sent on every request; only the import endpoints check it (ADR-009).
      ...(accessKey ? { 'X-Unlock-Key': accessKey } : {}),
      // Who owns the rows this request may see and create (#170). Separate from
      // the key on purpose: one grants permission, the other identifies a library.
      ...(installId ? { 'X-Install-Id': installId } : {}),
      ...init?.headers,
    },
  })

  if (!response.ok) {
    throw new ApiError(response.status, await errorMessage(response))
  }
  // 204 No Content has an empty body, so there's nothing to parse.
  if (response.status === 204) return undefined as T

  return (await response.json()) as T
}

/** Build a query string, omitting undefined/empty values. */
export function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const result = search.toString()
  return result ? `?${result}` : ''
}

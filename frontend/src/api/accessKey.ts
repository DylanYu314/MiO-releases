/**
 * The access key (ADR-009) the client sends as `X-Unlock-Key` on every request;
 * only the import endpoints enforce it. Stored in localStorage, entered in
 * Settings. A capability token, so treat it like a password.
 */
const ACCESS_KEY_STORAGE = 'mio-access-key'

export function getAccessKey(): string {
  if (typeof localStorage === 'undefined') return ''
  return localStorage.getItem(ACCESS_KEY_STORAGE) ?? ''
}

export function setAccessKey(value: string): void {
  const trimmed = value.trim()
  if (trimmed) localStorage.setItem(ACCESS_KEY_STORAGE, trimmed)
  else localStorage.removeItem(ACCESS_KEY_STORAGE)
}

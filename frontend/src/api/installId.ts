/**
 * This browser's install identity (#170).
 *
 * **Owns the library; grants nothing.** The access key decides whether you may
 * search and import; this decides whose songs you see. They were the same field
 * until #170, which meant every keyless visitor shared one library and adding a
 * key later hid everything imported before it.
 *
 * Minted here rather than issued by the server, so a first request needs no
 * handshake. It is therefore an *anonymous* identity, not an account: whoever
 * holds the value owns that library, exactly as any localStorage identity works.
 * Phase 6's auth is what replaces it.
 *
 * Clearing site data loses the library. That is the honest cost, and the reason
 * this is a stepping stone rather than a destination.
 */
const INSTALL_ID_STORAGE = 'mio-install-id'

/** 32 bytes of randomness, hex-encoded — long enough that guessing someone
 *  else's is not a strategy. */
function mint(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function getInstallId(): string {
  // Server-side rendering and the unit tests both run without localStorage. An
  // empty value means "no identity", which the backend turns into an empty
  // library rather than an error on reads.
  if (typeof localStorage === 'undefined') return ''

  const existing = localStorage.getItem(INSTALL_ID_STORAGE)
  if (existing) return existing

  const minted = mint()
  localStorage.setItem(INSTALL_ID_STORAGE, minted)
  return minted
}

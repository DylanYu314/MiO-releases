import type { ReactNode } from 'react'

import { useAccessStatus } from '../api/access'
import { LockedNotice } from './LockedNotice'

/** Wraps an import feature: shows the locked notice when the server gates
 *  importing and this device has no valid key, otherwise the feature itself.
 *  While the status is still loading it shows the feature (the unlocked steady
 *  state), so an already-unlocked user sees no flash. */
export function ImportGate({ children }: { children: ReactNode }) {
  const { data } = useAccessStatus()
  if (data?.locked && !data.unlocked) return <LockedNotice />
  return <>{children}</>
}

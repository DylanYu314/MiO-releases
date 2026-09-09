import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert } from 'lucide-react'

import { useAccessStatus } from '../api/access'
import { EmptyState } from './ui'

/**
 * Hides a developer-only view from everyone but an administrator (#354).
 *
 * **Not `ImportGate`, and that distinction is the whole point.** `ImportGate`
 * asks "does this key open the import gate", which every invited tester's key
 * does. The first attempt at protecting the diagnostics page used it and was
 * barely a fix: any tester could have read every other tester's crash reports,
 * and whatever they typed into "what were you doing".
 *
 * It also fails **closed**: while the status request is in flight `data` is
 * undefined and nothing is shown.
 *
 * That last part is belt-and-braces rather than the control, and it is worth
 * being honest about which is which. What actually keeps other people\'s reports
 * out of a browser is that `DiagnosticsPage` does not *fetch* them unless the
 * key is admin, and that the server answers 403 regardless. A mutation making
 * this component render its children while loading leaks nothing, because there
 * is nothing loaded to leak — no test catches it, and none should be contorted
 * into doing so.
 */
export function AdminGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  const { data } = useAccessStatus()

  if (!data?.admin) {
    return (
      <EmptyState
        icon={<ShieldAlert className="h-8 w-8" aria-hidden />}
        title={t('diagnostics.adminOnly')}
        description={t('diagnostics.adminOnlyHint')}
      />
    )
  }
  return <>{children}</>
}

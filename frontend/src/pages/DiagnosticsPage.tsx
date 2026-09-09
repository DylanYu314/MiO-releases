import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardList } from 'lucide-react'

import {
  CLIENT_ERRORS_PAGE_LIMIT,
  useClientErrors,
  type ClientError,
  type ClientErrorLevel,
  type ClientErrorLevelFilter,
} from '../api/clientErrors'
import { useAccessStatus } from '../api/access'
import { AdminGate } from '../components/AdminGate'
import { Pagination } from '../components/Pagination'
import { EmptyState, Spinner } from '../components/ui'

/**
 * Where the clients' reports are actually read (#322).
 *
 * `POST /client-errors` has been storing crashes since #136 and `GET
 * /client-errors` has answered since then too — with **nothing anywhere calling
 * it**. This page is that missing half, and it is on the laptop rather than the
 * phone because a laptop is where anyone sits down to read a log.
 *
 * Deliberately plain. It is a table of what happened, newest first, filtered by
 * level, with the stack behind a disclosure so a hundred lines of trace cannot
 * push the next row off the screen.
 */

const FILTERS: ClientErrorLevelFilter[] = ['all', 'error', 'warn', 'info']

const LEVEL_CLASS: Record<ClientErrorLevel, string> = {
  error: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  warn: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  info: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
}

export function DiagnosticsPage() {
  const { t } = useTranslation()
  const [level, setLevel] = useState<ClientErrorLevelFilter>('all')
  const [offset, setOffset] = useState(0)
  // The reports are not fetched at all unless this key may see them (#354).
  // The server would answer 403 anyway, so the request is guaranteed waste —
  // and not making it means there is no moment where a non-administrator's
  // browser holds other people's crash reports in a query cache.
  const isAdmin = useAccessStatus().data?.admin === true
  const { data, isPending, isError } = useClientErrors(level, offset, isAdmin)

  function pickLevel(next: ClientErrorLevelFilter) {
    setLevel(next)
    // Page 3 of "all" is not page 3 of "errors" — keeping the offset would land
    // on an empty page and read as "there are none".
    setOffset(0)
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">
          {t('diagnostics.title')}
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {t('diagnostics.pageDescription')}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => pickLevel(option)}
            aria-pressed={level === option}
            className={`rounded-full px-3 py-1 text-sm transition ${
              level === option
                ? 'bg-accent-600 text-white'
                : 'border border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700'
            }`}
          >
            {t(`diagnostics.level.${option}`)}
          </button>
        ))}
      </div>

      {/*
        Gated (#354). This is the developer's view of *everyone's* reports —
        stack traces, whatever users typed into "what were you doing", and a
        daily log from every install. It sat on a public domain behind no
        credential at all until this was added.

        `AdminGate`, **not** `ImportGate`: every invited tester's key opens the
        import gate, so gating on that would have let any of them read all the
        others' reports. Only an admin-flagged key gets in here.
      */}
      <AdminGate>
        {isPending && <Spinner />}

        {isError && (
          <p className="text-sm text-red-600 dark:text-red-400">{t('diagnostics.loadFailed')}</p>
        )}

        {data && data.items.length === 0 && (
          <EmptyState
            icon={<ClipboardList className="h-8 w-8" aria-hidden />}
            title={t('diagnostics.empty')}
            description={t('diagnostics.emptyHint')}
          />
        )}

        {data && data.items.length > 0 && (
          <>
            <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
              {data.items.map((report) => (
                <ReportRow key={report.id} report={report} />
              ))}
            </ul>
            <Pagination
              total={data.total}
              limit={CLIENT_ERRORS_PAGE_LIMIT}
              offset={offset}
              onOffsetChange={setOffset}
            />
          </>
        )}
      </AdminGate>
    </div>
  )
}

function ReportRow({ report }: { report: ClientError }) {
  const { t } = useTranslation()

  // Everything that says *which device and when*, on one line. A report from
  // one of several testers is only actionable if you know whose it is.
  const context = [
    report.platform,
    report.device,
    report.app_version && `v${report.app_version}`,
    report.os_version,
    // Which install, not which phone model (#354). Two testers on the same
    // handset are otherwise indistinguishable, which is most of what a
    // developer view is for.
    report.owner_install_id != null && `install #${report.owner_install_id}`,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <li className="space-y-1 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded px-1.5 py-0.5 text-xs font-semibold uppercase ${LEVEL_CLASS[report.level] ?? LEVEL_CLASS.info}`}
        >
          {report.level}
        </span>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {new Date(report.created_at).toLocaleString()}
        </span>
        {context && <span className="text-xs text-slate-400 dark:text-slate-500">{context}</span>}
      </div>

      <p className="break-words font-mono text-sm text-slate-800 dark:text-slate-200">
        {report.message}
      </p>

      {/* The only field a person wrote — on a crash it is what they were doing,
          and on an uploaded log line it is the device's own timestamp. */}
      {report.description && (
        <p className="text-sm text-slate-600 dark:text-slate-300">{report.description}</p>
      )}

      {/* Behind a disclosure: a hundred lines of trace would otherwise push the
          next row off the screen, and the message is usually enough. */}
      {report.stack && (
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
            {t('diagnostics.stack')}
          </summary>
          <pre className="mt-1 overflow-x-auto rounded bg-slate-100 p-2 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
            {report.stack}
          </pre>
        </details>
      )}
    </li>
  )
}

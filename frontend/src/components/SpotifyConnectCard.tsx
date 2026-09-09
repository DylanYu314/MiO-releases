import { Trans, useTranslation } from 'react-i18next'

import { useDisconnectSpotify, useSpotifyStatus } from '../api/spotify'
import type { SpotifyAccount } from '../api/types'
import { useConfirm } from './ui/confirm/context'

export function SpotifyConnectCard() {
  const { t } = useTranslation()
  const { data, isPending, isError, error } = useSpotifyStatus()
  const disconnect = useDisconnectSpotify()
  const confirm = useConfirm()

  async function handleDisconnect(account: SpotifyAccount) {
    const name = account.display_name ?? account.spotify_user_id
    const ok = await confirm({
      title: t('spotify.disconnectTitle'),
      message: t('spotify.disconnectMessage', { name }),
      confirmLabel: t('spotify.disconnect'),
      danger: true,
    })
    if (ok) disconnect.mutate(account.id)
  }

  return (
    <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
      <h3 className="font-semibold text-slate-900 dark:text-slate-100">{t('spotify.title')}</h3>

      {isPending && (
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('spotify.checking')}</p>
      )}

      {isError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {t('spotify.checkError', { message: error.message })}
        </p>
      )}

      {data && !data.configured && (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          <Trans i18nKey="spotify.notConfigured" components={{ code: <code /> }} />
        </p>
      )}

      {data?.configured && data.accounts.length === 0 && (
        <div className="space-y-3">
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('spotify.noAccount')}</p>
          {/* A real navigation, not fetch: the backend answers with a redirect
              to Spotify's consent page, which the browser must follow. */}
          <a
            href="/api/spotify/login"
            className="inline-block rounded-lg bg-accent-600 px-4 py-2 font-medium text-white transition hover:bg-accent-700"
          >
            {t('spotify.connect')}
          </a>
        </div>
      )}

      {data?.configured && data.accounts.length > 0 && (
        <div className="space-y-3">
          <ul className="space-y-2">
            {data.accounts.map((account) => (
              <li
                key={account.id}
                className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 p-3 dark:border-slate-700"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-900 dark:text-slate-100">
                    {account.display_name ?? account.spotify_user_id}
                  </p>
                  <p className="truncate text-sm text-slate-500 dark:text-slate-400">
                    {account.spotify_user_id}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleDisconnect(account)}
                  disabled={disconnect.isPending && disconnect.variables === account.id}
                  className="shrink-0 rounded px-2 py-1 text-sm text-slate-500 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:text-slate-400 dark:hover:bg-red-950 dark:hover:text-red-400"
                >
                  {t('spotify.disconnect')}
                </button>
              </li>
            ))}
          </ul>

          <a
            href="/api/spotify/login"
            className="text-sm font-medium text-accent-600 hover:underline dark:text-accent-400"
          >
            {t('spotify.connectAnother')}
          </a>

          {disconnect.isError && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {disconnect.error.message}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

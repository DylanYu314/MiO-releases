import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { useCreatePlaylistImport } from '../api/playlistImports'
import { useSpotifyPlaylists } from '../api/spotify'
import { LIKED_SONGS_ID, type SpotifyAccount, type SpotifyPlaylist } from '../api/types'
import { Pagination } from './Pagination'
import { Music } from 'lucide-react'

interface SpotifyPlaylistPickerProps {
  accounts: SpotifyAccount[]
}

export function SpotifyPlaylistPicker({ accounts }: SpotifyPlaylistPickerProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null)
  const [offset, setOffset] = useState(0)

  // The parent only renders this with at least one account connected.
  const accountId = selectedAccountId ?? accounts[0].id

  const { data, isPending, isError, error } = useSpotifyPlaylists(accountId, offset)
  const createImport = useCreatePlaylistImport()

  function handleAccountChange(value: string) {
    setSelectedAccountId(Number(value))
    setOffset(0) // New account, new list — page 1. Reset here, not in an effect.
  }

  function handleImport(playlistId: string, name: string) {
    createImport.mutate(
      { accountId, playlistId, name },
      { onSuccess: (created) => navigate(`/import/${created.id}`) },
    )
  }

  const importingId = createImport.isPending ? createImport.variables?.playlistId : null

  return (
    <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-800">
      <div className="flex items-center justify-between gap-4">
        <h3 className="font-semibold text-slate-900 dark:text-slate-100">
          {t('spotify.pickPlaylist')}
        </h3>
        {accounts.length > 1 && (
          <select
            value={accountId}
            onChange={(event) => handleAccountChange(event.target.value)}
            aria-label={t('spotify.accountAria')}
            className="rounded-lg border border-slate-300 px-2 py-1 text-sm outline-none focus:border-accent-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.display_name ?? account.spotify_user_id}
              </option>
            ))}
          </select>
        )}
      </div>

      {isPending && (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t('spotify.loadingPlaylists')}
        </p>
      )}

      {isError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error.message}
        </p>
      )}

      {data && (
        <ul className="space-y-2">
          <PlaylistRow
            playlist={{
              id: LIKED_SONGS_ID,
              name: t('spotify.likedSongs'),
              image_url: null,
              track_count: 0,
              owner_name: null,
            }}
            subtitle={t('spotify.likedSubtitle')}
            onImport={() => handleImport(LIKED_SONGS_ID, t('spotify.likedSongs'))}
            isImporting={importingId === LIKED_SONGS_ID}
          />
          {data.items.map((playlist) => (
            <PlaylistRow
              key={playlist.id}
              playlist={playlist}
              subtitle={[
                t('spotify.trackCount', { count: playlist.track_count }),
                playlist.owner_name ? t('spotify.byOwner', { name: playlist.owner_name }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              onImport={() => handleImport(playlist.id, playlist.name)}
              isImporting={importingId === playlist.id}
            />
          ))}
        </ul>
      )}

      {createImport.isError && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {createImport.error.message}
        </p>
      )}

      {data && (
        <Pagination
          total={data.total}
          limit={data.limit}
          offset={data.offset}
          onOffsetChange={setOffset}
        />
      )}
    </section>
  )
}

function PlaylistRow({
  playlist,
  subtitle,
  onImport,
  isImporting,
}: {
  playlist: SpotifyPlaylist
  subtitle: string
  onImport: () => void
  isImporting: boolean
}) {
  const { t } = useTranslation()

  return (
    <li className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      {playlist.image_url ? (
        <img src={playlist.image_url} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
      ) : (
        <div
          aria-hidden
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400"
        >
          <Music className="h-5 w-5" aria-hidden />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-slate-900 dark:text-slate-100">{playlist.name}</p>
        <p className="truncate text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
      </div>
      <button
        type="button"
        onClick={onImport}
        disabled={isImporting}
        className="shrink-0 rounded-lg bg-accent-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-accent-700 disabled:opacity-50"
      >
        {isImporting ? t('common.starting') : t('spotify.import')}
      </button>
    </li>
  )
}

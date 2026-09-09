import { Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NavLink, Route, Routes } from 'react-router-dom'

import { OnboardingOverlay } from './components/OnboardingOverlay'
import { PlayerBar } from './components/PlayerBar'
import { useOnboardingStore } from './onboarding/store'
import { AddLinkPage } from './pages/AddLinkPage'
import { DiagnosticsPage } from './pages/DiagnosticsPage'
import { ImportDetailPage } from './pages/ImportDetailPage'
import { ImportPage } from './pages/ImportPage'
import { LibraryPage } from './pages/LibraryPage'
import { PlaylistDetailPage } from './pages/PlaylistDetailPage'
import { FavouritesPage } from './pages/FavouritesPage'
import { PlaylistsPage } from './pages/PlaylistsPage'
import { SearchPage } from './pages/SearchPage'
import { SettingsPage } from './pages/SettingsPage'

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-lg px-3 py-1.5 text-sm font-medium transition ${
    isActive
      ? 'bg-accent-600 text-white'
      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700'
  }`

export function App() {
  const { t } = useTranslation()
  const onboardingCompleted = useOnboardingStore((state) => state.completed)

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
      <header className="border-b border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-800">
        <div className="mx-auto flex max-w-4xl items-center gap-6 px-4 py-3">
          <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">MiO</h1>
          <nav className="flex gap-1">
            <NavLink to="/" end className={navLinkClass}>
              {t('nav.library')}
            </NavLink>
            <NavLink to="/favourites" className={navLinkClass}>
              {t('nav.favourites')}
            </NavLink>
            <NavLink to="/playlists" className={navLinkClass}>
              {t('nav.playlists')}
            </NavLink>
            <NavLink to="/import" className={navLinkClass}>
              {t('nav.import')}
            </NavLink>
            <NavLink to="/add" className={navLinkClass}>
              {t('nav.addLink')}
            </NavLink>
            <NavLink to="/search" className={navLinkClass}>
              {t('nav.search')}
            </NavLink>
          </nav>
          <NavLink
            to="/settings"
            className={(props) => `${navLinkClass(props)} ml-auto`}
            aria-label={t('nav.settings')}
          >
            <Settings className="h-4 w-4" aria-hidden />
          </NavLink>
        </div>
      </header>

      {/* Bottom padding keeps the last row clear of the fixed player bar. */}
      <main className="mx-auto max-w-4xl px-4 py-6 pb-32">
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/favourites" element={<FavouritesPage />} />
          <Route path="/playlists" element={<PlaylistsPage />} />
          <Route path="/playlists/:id" element={<PlaylistDetailPage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/import/:id" element={<ImportDetailPage />} />
          <Route path="/add" element={<AddLinkPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          {/* Reached from Settings rather than the nav bar: it is for the
              session where something has gone wrong, not a place to live. */}
          <Route path="/diagnostics" element={<DiagnosticsPage />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>

      {/* Outside <Routes> so playback survives navigation. */}
      <PlayerBar />

      {/* Mounted only while unfinished, so it always opens at step 0. */}
      {!onboardingCompleted && <OnboardingOverlay />}
    </div>
  )
}

function NotFound() {
  const { t } = useTranslation()
  return <p className="text-slate-500 dark:text-slate-400">{t('common.pageNotFound')}</p>
}

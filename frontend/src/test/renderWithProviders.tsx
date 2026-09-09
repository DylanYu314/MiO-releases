import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

import { ConfirmProvider } from '../components/ui/confirm/ConfirmProvider'
import { ToastProvider } from '../components/ui/toast/ToastProvider'
import i18n from '../i18n'

interface Options {
  /** The browser path to start at, e.g. '/playlists/5'. */
  route?: string
  /** The route pattern to match `ui` against, e.g. '/playlists/:id'. Needed
   *  when the component under test reads params via useParams. */
  path?: string
}

/** Render a component with the providers the real app supplies. */
export function renderWithProviders(ui: ReactElement, { route = '/', path }: Options = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      // Retries would make failure tests wait through several backoffs.
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

  // When a path pattern is given, mount the component through a matching Route so
  // useParams resolves; otherwise render it directly.
  const content = path ? (
    <Routes>
      <Route path={path} element={ui} />
    </Routes>
  ) : (
    ui
  )

  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <ConfirmProvider>
            <MemoryRouter initialEntries={[route]}>{content}</MemoryRouter>
          </ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  )
}

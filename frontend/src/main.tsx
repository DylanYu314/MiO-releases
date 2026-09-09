import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'

import { App } from './App.tsx'
import { ConfirmProvider } from './components/ui/confirm/ConfirmProvider'
import { ToastProvider } from './components/ui/toast/ToastProvider'
import './i18n' // initialize i18next before anything renders
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The library only changes when this user changes it, so there's little
      // point refetching every time the window regains focus.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ConfirmProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
)

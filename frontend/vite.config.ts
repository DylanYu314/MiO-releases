import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Overridable so the end-to-end run can point at its own backend on another
// port, instead of colliding with a development stack on the usual one.
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://localhost:8000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The app calls /api/... and Vite forwards it to the backend, so the browser
    // only ever talks to one origin and the backend needs no CORS config.
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        // Job progress arrives over a WebSocket on this same prefix.
        ws: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    // Unit tests only. The Playwright specs in e2e/ are also *.spec.ts, and
    // Vitest would otherwise try to run them (and fail on test.describe).
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
  },
})

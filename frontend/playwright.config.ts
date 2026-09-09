import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end config: a real browser against a real backend.
 *
 * Playwright starts both servers itself, so `npm run test:e2e` is the whole
 * command. The backend reseeds a throwaway database as part of its own start
 * command — Playwright starts web servers *before* globalSetup, so seeding
 * there would race the app's startup — and runs with no Redis (tasks then run
 * inline) and no Spotify credentials. Nothing here touches the network or your
 * development data.
 */
// Deliberately not the development ports: an e2e run must never talk to (or
// wait on) a stack you already have running.
const BACKEND_PORT = 8100
const FRONTEND_PORT = 5273

const PYTHON = process.env.PYTHON_BIN ?? '.venv/bin/python'

// Every setting the suite depends on is pinned here, because the backend also
// reads backend/.env — an unpinned value silently takes whatever a developer
// has locally, and the run fails only on their machine (CI has no .env).
// REQUIRE_ACCESS_KEY is the one that bit: left unpinned, a local `true` locks
// the import page behind ImportGate and the Spotify-not-configured spec fails.
const BACKEND_ENV = {
  DATABASE_URL: 'sqlite:///./data/e2e.db',
  LIBRARY_PATH: './data/e2e-library',
  REDIS_URL: '',
  SPOTIFY_CLIENT_ID: '',
  REQUIRE_ACCESS_KEY: 'false',
  // The suite drives the whole app from one address far faster than a person
  // would, so the inbound limit (#514) is off here and covered by its own
  // backend tests instead.
  RATE_LIMIT_PER_MINUTE: '0',
  LOG_FORMAT: 'text',
}

export default defineConfig({
  testDir: './e2e',
  // The suite mutates shared server state (playlists, the library), so parallel
  // files would race each other.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: 'on-first-retry',
    // Pre-complete the first-run onboarding tour so its overlay doesn't sit over
    // the app during tests. The onboarding spec opts back out to see the tour.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: `http://localhost:${FRONTEND_PORT}`,
          localStorage: [
            {
              name: 'mio-onboarding',
              value: JSON.stringify({ state: { completed: true }, version: 1 }),
            },
            {
              // A fixed install identity (#170), so the seeded library has an
              // owner the browser will actually resolve to. Left to mint its own
              // random id, the client would own nothing and every list would be
              // empty. Must match E2E_INSTALL_TOKEN in backend/scripts/seed_e2e.py.
              name: 'mio-install-id',
              value: 'e2e-install-token-0123456789abcdef',
            },
          ],
        },
      ],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `${PYTHON} -m scripts.seed_e2e && ${PYTHON} -m uvicorn app.main:app --port ${BACKEND_PORT}`,
      // Both halves run with -m on purpose. Executed as a path,
      // `python scripts/seed_e2e.py` puts scripts/ on sys.path[0] and `app`
      // then resolves to the *installed* copy in site-packages, which goes
      // stale the moment a model changes — the seed would build an old schema
      // while uvicorn served the new models. -m puts the cwd first instead.
      cwd: '../backend',
      env: BACKEND_ENV,
      url: `http://localhost:${BACKEND_PORT}/health`,
      reuseExistingServer: false,
      stdout: 'pipe',
    },
    {
      command: `npm run dev -- --port ${FRONTEND_PORT} --strictPort`,
      url: `http://localhost:${FRONTEND_PORT}`,
      env: { VITE_API_TARGET: `http://localhost:${BACKEND_PORT}` },
      reuseExistingServer: false,
    },
  ],
})

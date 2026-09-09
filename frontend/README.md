# MiO web client

React + TypeScript + Vite front end for the MiO backend. See the repo root
the repository `README.md` for the project overview.

## Setup

Requires Node 22+ (`nvm install 22`).

```bash
npm install
npm run dev     # http://localhost:5173
```

The dev server proxies `/api/*` to the backend on `http://localhost:8000`
(see `vite.config.ts`), so start the backend too — from the repo root:

```bash
docker compose up --build
```

## Commands

| Command             | What it does                                             |
| ------------------- | -------------------------------------------------------- |
| `npm run dev`       | Start the dev server with hot reload                     |
| `npm run build`     | Typecheck and build for production into `dist/`          |
| `npm run lint`      | ESLint                                                   |
| `npm run format`    | Prettier, writing changes (`format:check` to only check) |
| `npm run typecheck` | TypeScript, no emit                                      |
| `npm run test`      | Vitest once (`test:watch` to keep it running)            |

## Layout

```
src/
  api/         Typed client + TanStack Query hooks, mirroring the backend schemas
  components/  Reusable presentational pieces
  pages/       Route-level components
  lib/         Small helpers (formatting, hooks)
  test/        Vitest setup and render helpers
```

# The web client, built once and served by Caddy.
#
# There is no Node in the final image: `npm run build` produces static files, and
# serving static files needs a web server, not a JavaScript runtime. The builder
# stage is discarded, so node_modules never reaches the server.

FROM node:22-slim AS build

WORKDIR /build

# `shared/` is a file: dependency of the frontend package (ADR-016), so it has to
# exist before `npm ci` resolves it. This build therefore expects the *repo root*
# as its context, not frontend/.
COPY shared/ ./shared/
COPY frontend/package.json frontend/package-lock.json ./frontend/

WORKDIR /build/frontend
RUN npm ci

COPY frontend/ ./
RUN npm run build


FROM caddy:2-alpine AS prod

COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /build/frontend/dist /srv

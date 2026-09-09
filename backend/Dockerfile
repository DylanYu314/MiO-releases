# Two targets from one file, so development and production cannot drift apart
# in the parts that matter (Python version, ffmpeg, the non-root user).
#
# `docker-compose.yml` builds `dev`; `docker-compose.prod.yml` builds `prod`.
# Neither is the implicit default — both compose files name their target, because
# an unnamed build takes the *last* stage, and silently shipping the wrong one is
# the kind of mistake that only shows up on the server.
#
# ## Every version comes from uv.lock (#290)
#
# Both targets install from an export of the committed lock, not from the ranges
# in pyproject.toml. Before this, each build asked PyPI for the newest thing
# satisfying `>=`, so **a green CI run did not reproduce** — #285 was a uvicorn
# patch release turning the repo red on unchanged code, and the 37 indirect
# packages nobody names move just as freely.
#
# `uv pip install` does not read a lock file, which is the trap here: it would
# accept the lock's presence and re-resolve anyway. `uv export` is what turns the
# lock into something it *does* obey, hashes included, and `--frozen` makes a
# lock that has drifted from pyproject.toml a build failure rather than a silent
# re-resolve.
#
# The project itself is deliberately not installed. It never usefully was: this
# COPY brings in pyproject.toml alone, so the wheel built here found no `app`
# package to include. The code is served from the working directory in both
# targets, and dropping the empty install removes the stale-site-packages trap
# that `docs/lessons.md` records.

FROM python:3.12-slim AS base

WORKDIR /app

RUN apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

# Run as a non-root user so files written into the bind-mounted ./backend
# volume (caches, __pycache__, etc.) stay owned by the host user, not root.
RUN useradd --create-home appuser

COPY pyproject.toml uv.lock ./


# ---------------------------------------------------------------------------
# Development: dev dependencies and a reloading server.
#
# The code arrives through a bind mount, so the COPY here only matters for a
# container started without one.
# ---------------------------------------------------------------------------
FROM base AS dev

RUN uv export --frozen --no-emit-project --group dev -o /tmp/requirements.txt \
    && uv pip install --system --no-cache --require-hashes -r /tmp/requirements.txt

COPY . .

USER appuser

CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"]


# ---------------------------------------------------------------------------
# Production: runtime dependencies only, code baked into the image, no reloader.
#
# No pytest, no ruff — they are a larger image and a larger attack surface for
# no benefit on a server. The reloader is worse than useless in production: it
# watches the filesystem forever and restarts the app if anything touches it,
# and the library directory *is* on the filesystem.
# ---------------------------------------------------------------------------
FROM base AS prod

# A JavaScript runtime, because yt-dlp needs one to extract from YouTube (#177).
#
# Without it, the signature and `n` challenges cannot be solved, so every client
# that needs them yields no usable formats and extraction falls back to
# `android_vr` — which on a datacenter IP answers `LOGIN_REQUIRED`, surfacing as
# "Sign in to confirm you're not a bot". Measured 2026-07-31: 1 success in 14.
#
# It is also what makes the *rest* of the anti-bot work possible at all.
# `android_vr` consumes neither a PO token nor cookies (`SUPPORTS_COOKIES` is
# False on it, True on `web`), so while extraction falls back to it the POT
# provider is loaded and never used, and a cookie file would be ignored. The
# runtime is a prerequisite for both, not an alternative to either.
#
# deno rather than node: it is the only runtime yt-dlp enables by default, so
# this needs no extractor-args to go with it. Copied from the official `bin`
# image — a single static binary, no package manager, no apt sources to trust.
COPY --from=denoland/deno:bin-2.9.4 /deno /usr/local/bin/deno

# The `pot` group is production-only on purpose (#161). YouTube flags datacenter
# IPs, not home ones, so a local install has nothing to prove and installing the
# plugin there would only make it reach for a provider that isn't running.
#
# `--no-dev` is not decoration: uv exports the `dev` group by default, so
# without it the production image would ship pytest and ruff.
RUN uv export --frozen --no-emit-project --no-dev --group pot -o /tmp/requirements.txt \
    && uv pip install --system --no-cache --require-hashes -r /tmp/requirements.txt

COPY . .

# Create the data directory *in the image*, owned by appuser, before any volume
# is mounted over it. Docker seeds an empty named volume from the image path it
# covers, ownership included — so this is what stops the volume arriving
# root-owned and the app failing to write its own database.
RUN mkdir -p /app/data/library && chown -R appuser:appuser /app/data

USER appuser

# Last in the stage, deliberately: this value changes on every commit, so
# anything below it would rebuild on every deploy. Nothing is below it but CMD,
# which is metadata.
#
# Surfaced on `/health` so CI can ask the running stack which commit it is,
# over plain HTTPS and with no deploy key (#731). An absent build arg leaves
# "unknown", which the drift check reads as drift rather than as "fine".
# ⚠️ Unprefixed inside the container, `MIO_`-prefixed outside it — the same
# split `LOG_LEVEL`/`MIO_LOG_LEVEL` already uses. `Settings` has no `env_prefix`,
# so the field `git_sha` reads `GIT_SHA` and nothing else.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA

CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]

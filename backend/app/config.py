from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./data/mio.db"
    library_path: str = "./data/library"

    # The commit this image was built from, baked in as a build arg (#731).
    #
    # ⛔ **"Deployed" is not "live", and it has cost real time five times here** —
    # a droplet fourteen commits behind for four days, a Caddy image serving a
    # page twelve days old, and a deploy that built the *dev* project beside
    # production and looked entirely successful. Every one was found by fetching
    # an artefact and looking; none by trusting a command's exit code.
    #
    # So the running stack publishes what it is, and CI compares that with `main`
    # over plain HTTPS — no deploy key, no access to production.
    #
    # ⚠️ **"unknown" is a failure, not a default to shrug at.** It means the image
    # was built without the build arg, i.e. by a deploy command that is not the
    # documented one — the same class of mistake as the wrong compose file. The
    # drift check treats it as drift.
    #
    # ⚠️ Unprefixed: `Settings` sets no `env_prefix`, so this reads `GIT_SHA`.
    # The `MIO_` prefix is host-side only, as with `MIO_LOG_LEVEL`/`LOG_LEVEL`.
    git_sha: str = "unknown"

    # Serve /docs, /redoc and /openapi.json (#765).
    #
    # ⛔ Default True so a local run and a self-hoster keep the interactive API
    # browser, which is most of what makes this backend approachable. Turned off
    # on the public droplet, where it published every endpoint, parameter and
    # schema to anyone who asked — free reconnaissance for an instance that has
    # no reader who needs it.
    #
    # ⚠️ Unprefixed, like `git_sha`: `Settings` sets no `env_prefix`, so this
    # reads `API_DOCS_ENABLED`.
    api_docs_enabled: bool = True

    # "json" for machine-queryable logs (the default, and what Docker gets),
    # "text" when a human is reading them live.
    log_level: str = "INFO"
    log_format: str = "json"

    # Celery's broker and the channel progress events travel on (ADR-006).
    # Empty disables both: tasks then run inline and events are delivered
    # in-process, which is what the test suite relies on.
    redis_url: str = "redis://localhost:6379/0"

    # Pacing and retries for downloads (ADR-006). The rate limit is what stops
    # a large import looking like a scraper — unpaced batches are what got us
    # throttled with HTTP 403s in the first place. Celery's syntax: "N/s|m|h".
    download_rate_limit: str = "20/m"
    # Batch imports call the pipeline inline (sequentially), so Celery's rate
    # limit doesn't apply to them — this pause between downloads is what paces
    # a long playlist. It's the *initial* delay; set to 0 to disable pacing.
    download_pacing_seconds: float = 3.0
    # Adaptive pacing (Enhancement Track B0): the delay shrinks after each
    # success and grows after a transient (throttling) failure, staying within
    # this band. Strictly sequential — the real throughput fix is Postgres in
    # Phase 6. Ignored when download_pacing_seconds is 0.
    download_pacing_min_seconds: float = 1.0
    download_pacing_max_seconds: float = 30.0
    download_pacing_shrink: float = 0.8  # multiply the delay by this on success
    download_pacing_grow: float = 2.0  # multiply the delay by this on a transient failure
    download_max_retries: int = 3
    # First retry waits this long; each subsequent one doubles it.
    download_retry_backoff_seconds: int = 20

    # How long one song's import may take before it is called hung (#213).
    #
    # Tasks acknowledge late (ADR-006) and the worker runs `--concurrency=2`, so
    # an extraction that never returns holds a slot **forever** — `restart:
    # unless-stopped` does not help, because a hung worker never exits. Two of
    # them and every later import sits at `queued`.
    #
    # 180s is roughly ten times a measured import (~13-20s on the server), so
    # only a genuine hang trips it. The limit exists to bound a wedge, not to
    # enforce speed: set it too close to real work and a long track on a slow
    # day fails for no reason.
    #
    # The soft limit raises `SoftTimeLimitExceeded` inside the task, which is
    # what lets the job be recorded as failed with a reason; the hard limit kills
    # the worker process if that is ignored or the hang is uninterruptible.
    #
    # **Deliberately not applied to playlist imports.** `run_confirmed_import`
    # downloads a whole playlist inside one task — a hundred tracks paced a few
    # seconds apart is half an hour of entirely legitimate work, and a limit
    # sized for one song would kill every batch import.
    download_soft_time_limit_seconds: int = 180
    download_time_limit_seconds: int = 240

    # Spotify import (Phase 3, ADR-005). Left unset, the /spotify endpoints
    # answer 503 and the rest of the app is unaffected. The redirect URI must
    # byte-for-byte match one registered in the Spotify developer dashboard —
    # loopback IP only, Spotify rejects the "localhost" hostname.
    spotify_client_id: str | None = None
    spotify_redirect_uri: str = "http://127.0.0.1:8000/spotify/callback"
    # Where the OAuth callback sends the browser afterwards (the web app).
    frontend_base_url: str = "http://localhost:5173"
    # …and where it sends it when the Android app started the login (#203).
    # A deep link, so the browser hands control back to the app: `mio` is the
    # scheme in `mobile/app.json`, and `add/import` is the path expo-router
    # resolves `app/(tabs)/add/import/index.tsx` to — a route group is not a
    # path segment. A setting rather than a constant so the scheme can move
    # without a code change, but the *choice* between this and the web URL is
    # made from a fixed pair in the router, never from a request parameter.
    spotify_app_redirect_uri: str = "mio://add/import"

    # Private YouTube playlist import (#106, ADR-014). Left unset, the /google
    # endpoints answer 503 and the rest of the app is unaffected — the same
    # bargain Spotify has.
    #
    # Unlike Spotify this needs a real **client secret**: Google issues one for
    # "Web application" clients and requires it at the token exchange, so it
    # lives on the server and never reaches a client. The redirect URI must
    # byte-for-byte match one registered in the Google Cloud console, including
    # scheme, case and trailing slash — `http://localhost` is allowed there,
    # which is the opposite of Spotify's rule.
    google_client_id: str | None = None
    google_client_secret: str | None = None
    google_redirect_uri: str = "http://localhost:8000/google/callback"

    # Access keys (ADR-009). The import gate is normally dormant until the first
    # key is created; set this true on a hosted deployment to keep imports locked
    # even before any key exists, so it's never accidentally open.
    # Inbound requests allowed per client per minute (#514). 0 disables it,
    # which is what a development run and both test suites want.
    #
    # ⚠️ **600, and the number came from being wrong at 120.** "A session is a
    # handful of calls" was a guess, and the e2e run refuted it immediately:
    # the web client requests **one cover image per song**, so opening a library
    # of 500 songs is 500 requests in a few seconds. At 120 the suite went red
    # with a page of `GET /songs/{id}/cover status=429` — a limit that breaks
    # ordinary use is worse than no limit at all.
    #
    # 600 still refuses a flood while letting a large library page load. It is
    # a *burst* allowance, not a sustained rate: the window slides, so 600 in
    # one second is fine and 601 is not.
    #
    # ⚠️ This is *inbound*. `download_rate_limit` above is Celery's pacing for
    # *outbound* downloads and the two are unrelated — the similarity of the
    # names is exactly why #514 recorded that no inbound limit existed at all.
    rate_limit_per_minute: int = 600

    require_access_key: bool = False

    # Proof-of-origin token provider (#161). YouTube refuses datacenter IPs with
    # "Sign in to confirm you're not a bot" on the first request — a problem of
    # address, not behaviour, so no amount of pacing helps. Pointing this at a
    # provider lets yt-dlp attach a token attesting the request is genuine.
    #
    # Empty on every local install: home connections are not flagged, and the
    # plugin is not installed outside the production image.
    ytdlp_pot_provider_url: str | None = None

    # An authenticated cookie file, as a stopgap for the same problem (#177).
    #
    # ⚠️ Interim, and known to be the wrong shape — #246 is the plan that
    # retires it. Measured 2026-07-31: the hosted server imported 1 URL in 14
    # while the same 14 succeeded from a home connection, and a JS runtime
    # (#245) did not move it. Every client is refused from a datacenter address,
    # and borrowing an account's identity is the only thing left that makes one
    # look like a person.
    #
    # Use a throwaway Google account. Cookies can be invalidated and the
    # account flagged, and this file is a credential living on a server —
    # `docs/deployment.md` has the export procedure and the reasons for it.
    ytdlp_cookies_file: str | None = None

    # How long a client's diagnostic rows are kept (#322).
    #
    # `client_errors` is written by an ungated endpoint and, since the phone
    # started uploading a daily log, by every device every day. Without a
    # ceiling it is the one table in this schema that grows forever on its own,
    # with nobody deleting from it — and the droplet's disk is the smallest one
    # DigitalOcean sells.
    #
    # 30 days is chosen against how the rows are actually used: they answer
    # "what happened when it broke", asked within a day or two. A month of
    # history is already far more than any question has needed. Set to 0 to
    # disable the sweep and keep everything.
    client_error_retention_days: int = 30


@lru_cache
def get_settings() -> Settings:
    return Settings()

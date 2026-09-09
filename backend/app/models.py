import enum
from datetime import UTC, datetime

from sqlalchemy import JSON, Boolean, DateTime, Enum, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import false

from app.db import Base


def _utcnow() -> datetime:
    return datetime.now(UTC)


class ImportStatus(enum.StrEnum):
    QUEUED = "queued"
    DOWNLOADING = "downloading"
    CONVERTING = "converting"
    TAGGING = "tagging"
    DONE = "done"
    FAILED = "failed"


class Song(Base):
    __tablename__ = "songs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str] = mapped_column(String(500), index=True)
    artist: Mapped[str] = mapped_column(String(500), index=True)
    album: Mapped[str | None] = mapped_column(String(500), nullable=True)
    duration: Mapped[float | None] = mapped_column(nullable=True)
    file_path: Mapped[str] = mapped_column(String(1000))
    file_hash: Mapped[str] = mapped_column(String(64))
    source_url: Mapped[str] = mapped_column(String(2000))
    source_platform: Mapped[str] = mapped_column(String(100))
    cover_path: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    # When a device said it holds this audio and the server deleted its own
    # copy (#221, ADR-017). Null means the server still has the file.
    #
    # An explicit column rather than inferring it from a missing file, because
    # the two states are not the same thing and the difference is the whole
    # point: "released to a device that confirmed receipt" is intended, and
    # "the file is not where the row says it is" is a fault. `file_path` is
    # kept either way — it is the record of what was there, and nulling it
    # would need a table rebuild for a column that is NOT NULL.
    audio_released_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # EBU R128 measurements, taken once at import (app/loudness.py). Nullable
    # because every song predating this column has none, and because a silent
    # file legitimately has no usable level. Playback applies a gain derived
    # from these; the audio itself is never rewritten.
    loudness_lufs: Mapped[float | None] = mapped_column(nullable=True)
    peak_dbfs: Mapped[float | None] = mapped_column(nullable=True)

    # Who owns this row. An *install*, not an access key (#170): the key only
    # unlocks search and import, and says nothing about what you can see.
    # Nullable because rows predating installs have no owner and are visible to
    # nobody, which is deliberate.
    owner_install_id: Mapped[int | None] = mapped_column(
        ForeignKey("installs.id"), nullable=True, index=True
    )

    # Deleting a Song removes its playlist entries too. Handled at the ORM level
    # rather than via ON DELETE CASCADE because SQLite doesn't enforce foreign
    # keys unless PRAGMA foreign_keys is on — this way it works on any backend.
    playlist_items: Mapped[list["PlaylistItem"]] = relationship(
        back_populates="song", cascade="all, delete-orphan"
    )


class ImportJob(Base):
    __tablename__ = "import_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source_url: Mapped[str] = mapped_column(String(2000))
    status: Mapped[ImportStatus] = mapped_column(
        Enum(ImportStatus, native_enum=False), default=ImportStatus.QUEUED
    )
    progress: Mapped[int | None] = mapped_column(nullable=True)
    song_id: Mapped[int | None] = mapped_column(ForeignKey("songs.id"), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    song: Mapped[Song | None] = relationship("Song")

    # Who owns this row. An *install*, not an access key (#170): the key only
    # unlocks search and import, and says nothing about what you can see.
    # Nullable because rows predating installs have no owner and are visible to
    # nobody, which is deliberate.
    owner_install_id: Mapped[int | None] = mapped_column(
        ForeignKey("installs.id"), nullable=True, index=True
    )


class SpotifyAccount(Base):
    """A connected Spotify login. The app is single-user, so accounts are
    global: whoever is at the keyboard can import from any connected one."""

    __tablename__ = "spotify_accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    spotify_user_id: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    display_name: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # Stored as plain text, decided rather than deferred (#687, 2026-09-03).
    #
    # ⚠️ This comment used to read "Revisit before any cloud deployment
    # (ADR-005)" — a precondition that lapsed on 2026-07-29 and went unnoticed
    # for over a month, because a comment stating its own condition is not a
    # mechanism for checking it. What follows is the reasoning that actually
    # applies now.
    #
    # - The scopes are **read-only** playlist scopes, so the blast radius is
    #   reading playlists, not touching the account.
    # - Reading these requires reading the SQLite file, which means already
    #   having the box or a copy of its volume.
    # - Since #608 the shipped app never connects Spotify to a server at all:
    #   `mobile/src/library/spotifyAuth.ts` does the whole OAuth flow on the
    #   phone and keeps the pair in `expo-secure-store`, which is OS-encrypted.
    #   So this table is a **self-hoster's own tokens on their own machine**.
    #
    # ⛔ Encrypting with a key stored on the same box would protect against
    # exactly one thing: a copy of `mio-data` travelling without `.env.prod`.
    # That is a real scenario — `docs/deployment.md`'s migration copies
    # `mio-data.tgz` off the server — so it is documented **there** as a secret
    # to handle and delete, which is the honest fix. What is not worth it is a
    # key-management system (rotation, restore onto a new box, what a wrong key
    # looks like at startup) whose failure mode is silently failing to decrypt,
    # which looks solved and is worse than this.
    #
    # The mechanism that *does* exist is `tests/test_token_exposure.py`: no
    # response schema may carry a token field. That is the leak worth guarding,
    # and unlike a comment it can fail.
    access_token: Mapped[str] = mapped_column(Text)
    refresh_token: Mapped[str] = mapped_column(Text)
    token_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    scopes: Mapped[str] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )


class GoogleAccount(Base):
    """A connected Google login, for importing private YouTube playlists (#106).

    Keyed on the **YouTube channel**, not a Google user id: `youtube.readonly`
    grants no access to profile or email, and the channel is what every call is
    scoped to anyway. It also means the row says something recognisable — the
    channel's name — instead of an opaque subject id.

    Global rather than per-install, the same as `SpotifyAccount`: the server
    side of this app is single-user, and #170's install identity decides whose
    *library* rows are whose, not who may connect an account.

    ## Why there is no import row pointing at this

    A private playlist hands back video ids, so there is nothing to match and
    nothing to review — the phone downloads them directly (#246). This table
    exists only so the OAuth tokens survive a restart; no `PlaylistImport` is
    ever created for a Google import.
    """

    __tablename__ = "google_accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    channel_id: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    channel_title: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # Stored as plain text, the same decision SpotifyAccount now records in
    # full (#687). ⚠️ **#687's title names only Spotify and this table has the
    # identical problem** — which is why that comment said "revisit together,
    # not separately", and why the guard in `tests/test_token_exposure.py`
    # walks every schema rather than naming one.
    #
    # One thing here is narrower still: `GOOGLE_IMPORT_ENABLED` is `false`
    # (#504), so the shipped app does not even offer the flow.
    access_token: Mapped[str] = mapped_column(Text)
    refresh_token: Mapped[str] = mapped_column(Text)
    token_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    scopes: Mapped[str] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )


class PlaylistImportStatus(enum.StrEnum):
    QUEUED = "queued"
    FETCHING = "fetching"
    MATCHING = "matching"
    REVIEW = "review"
    IMPORTING = "importing"
    DONE = "done"
    FAILED = "failed"


class TrackMatchStatus(enum.StrEnum):
    PENDING = "pending"
    AUTO_MATCHED = "auto_matched"
    NEEDS_REVIEW = "needs_review"
    NO_MATCH = "no_match"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    IMPORTED = "imported"
    FAILED = "failed"


class PlaylistImport(Base):
    """One attempt at importing an external playlist. Spotify is only needed
    while `fetching`; from `matching` on, the run is Spotify-free (ADR-005)."""

    __tablename__ = "playlist_imports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    service: Mapped[str] = mapped_column(String(50), default="spotify")
    # Nulled if the account is disconnected — the import history stays.
    account_id: Mapped[int | None] = mapped_column(ForeignKey("spotify_accounts.id"), nullable=True)
    # The playlist's id at the service; the sentinel "liked" means Liked Songs.
    external_playlist_id: Mapped[str] = mapped_column(String(200))
    name: Mapped[str] = mapped_column(String(300))
    status: Mapped[PlaylistImportStatus] = mapped_column(
        Enum(PlaylistImportStatus, native_enum=False), default=PlaylistImportStatus.QUEUED
    )
    track_count: Mapped[int | None] = mapped_column(nullable=True)
    matched_count: Mapped[int] = mapped_column(Integer, default=0)
    import_total: Mapped[int | None] = mapped_column(nullable=True)
    imported_count: Mapped[int] = mapped_column(Integer, default=0)
    failed_count: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The local playlist created for the downloaded songs (confirm phase).
    playlist_id: Mapped[int | None] = mapped_column(ForeignKey("playlists.id"), nullable=True)
    # Whether the *client* supplies the YouTube candidates for each track (#353).
    #
    # False is the historical behaviour and stays the default: the matching
    # phase searches YouTube itself. True means it fetches the tracklist and
    # then stops, waiting for `POST /{id}/candidates` — which the phone can
    # answer and this server cannot, because YouTube refuses a datacenter
    # address on every client (#177) and a residential one is not refused.
    #
    # A column rather than a request-scoped flag because the pipeline is a
    # Celery task: it reads the run back out of the database, and nothing of the
    # original request survives to it.
    # `server_default` as well as `default`, exactly as `AccessKey.is_admin`
    # does: a NOT NULL column added to a table with rows in it needs the
    # database to have an answer for those rows, not just the ORM.
    client_matches: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false(), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    # Who owns this row. An *install*, not an access key (#170): the key only
    # unlocks search and import, and says nothing about what you can see.
    # Nullable because rows predating installs have no owner and are visible to
    # nobody, which is deliberate.
    owner_install_id: Mapped[int | None] = mapped_column(
        ForeignKey("installs.id"), nullable=True, index=True
    )

    matches: Mapped[list["TrackMatch"]] = relationship(
        back_populates="playlist_import",
        cascade="all, delete-orphan",
        order_by="TrackMatch.position",
    )


class TrackMatch(Base):
    """One external track and what we found for it on YouTube."""

    __tablename__ = "track_matches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    playlist_import_id: Mapped[int] = mapped_column(ForeignKey("playlist_imports.id"), index=True)
    position: Mapped[int] = mapped_column(Integer)
    external_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    title: Mapped[str] = mapped_column(String(500))
    artist: Mapped[str] = mapped_column(String(500))
    album: Mapped[str | None] = mapped_column(String(500), nullable=True)
    duration_s: Mapped[float | None] = mapped_column(nullable=True)
    # Top search candidates as [{url, title, uploader, duration, score}], best
    # first — kept so the review UI can offer alternatives without re-searching.
    candidates: Mapped[list] = mapped_column(JSON, default=list)
    chosen_url: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    confidence: Mapped[float | None] = mapped_column(nullable=True)
    status: Mapped[TrackMatchStatus] = mapped_column(
        Enum(TrackMatchStatus, native_enum=False), default=TrackMatchStatus.PENDING
    )
    import_job_id: Mapped[int | None] = mapped_column(ForeignKey("import_jobs.id"), nullable=True)
    song_id: Mapped[int | None] = mapped_column(ForeignKey("songs.id"), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)

    playlist_import: Mapped[PlaylistImport] = relationship(back_populates="matches")


class PlaylistKind(enum.StrEnum):
    USER = "user"
    FAVOURITES = "favourites"


class Playlist(Base):
    __tablename__ = "playlists"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(300))
    # Favourites is a real playlist row, not a flag on Song, so it reorders and
    # plays like any other. There is at most one, created on first use.
    kind: Mapped[PlaylistKind] = mapped_column(
        Enum(PlaylistKind, native_enum=False), default=PlaylistKind.USER, server_default="user"
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    # Who owns this row. An *install*, not an access key (#170): the key only
    # unlocks search and import, and says nothing about what you can see.
    # Nullable because rows predating installs have no owner and are visible to
    # nobody, which is deliberate.
    owner_install_id: Mapped[int | None] = mapped_column(
        ForeignKey("installs.id"), nullable=True, index=True
    )

    items: Mapped[list["PlaylistItem"]] = relationship(
        back_populates="playlist",
        cascade="all, delete-orphan",
        order_by="PlaylistItem.position",
    )


class PlaylistItem(Base):
    """A song's placement inside a playlist. `position` is 0-based and dense."""

    __tablename__ = "playlist_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    playlist_id: Mapped[int] = mapped_column(ForeignKey("playlists.id"), index=True)
    song_id: Mapped[int] = mapped_column(ForeignKey("songs.id"), index=True)
    position: Mapped[int] = mapped_column(Integer)

    playlist: Mapped[Playlist] = relationship(back_populates="items")
    song: Mapped[Song] = relationship(back_populates="playlist_items")


class Install(Base):
    """One installation of a client, and the owner of everything it imports (#170).

    **Not an account.** There is no login, no password and no person attached —
    only a random token the client mints on first launch and then presents on
    every request. It exists because ownership and permission are different
    questions, and P12 had answered both with the access key: a keyless user's
    rows were owned by nobody, so every keyless user shared one library, and
    adding a key later hid everything they had already imported.

    Only the token's SHA-256 hash is stored, for the same reason `AccessKey`
    does it — a database leak then exposes nothing usable.

    Losing the token means losing the library, because nothing else identifies
    it. That is the honest cost of an anonymous identity, and what real accounts
    in Phase 6 are for.
    """

    __tablename__ = "installs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AccessKey(Base):
    """A revocable, tracked capability token gating the import entrypoints
    (ADR-009). Only the SHA-256 hash of the key is stored — the token itself is
    shown once, at creation. This is the seed of the Phase-6 membership tier,
    not an account system: there are no users, logins or passwords here.

    ## Two kinds, since #354

    An ordinary key says "you may import". An **admin** key additionally says
    "you may read everyone's diagnostics", which is a different and much larger
    permission: crash reports, and what every tester typed into "what were you
    doing".

    They had to separate because every invited tester holds an ordinary key.
    Gating the developer view on `require_unlock_key` would have let any tester
    read every other tester's reports — which is what #354 shipped for an hour
    before I pointed out that *"unlock key wont protect it, any user with it
    can still access it, not only me have it."*

    Admin is a **superset**: an admin key passes the import gate too, so there is
    still one key field in every client and no second credential to carry.
    """

    __tablename__ = "access_keys"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    key_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    label: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Whether this key may read other people's diagnostics (#354). Defaults
    # false and server-defaults false, so every key that existed before this
    # column — all of them handed to testers — is not one.
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())


class ClientError(Base):
    """Something that broke in a client, reported by the client itself (P9).

    The pilot tester is non-technical and phone-first, so "find the log and email
    it to me" is not a plan. The app reports its own crashes, and can carry the
    user's own description of what they were doing.

    **Reports go to this server, not a third-party.** That is the same reasoning
    as the rest of the project: a crash report contains a stack trace from
    someone's music app, and there is no reason for that to leave the machine
    that already holds their library.

    ## What is deliberately not here

    No song titles, artists or source URLs. A trace can still incidentally
    contain a request path like `/songs/12/audio` — an id, not a name — and that
    is the honest limit of scrubbing something you did not write.

    **#322 broke this and #354 repaired it.** The device log logged the URL being
    imported, the title that succeeded and the title that failed to play, and
    uploaded them here daily — a record of what each person listens to, on the
    one server whose justification is that it does not hold their library. The
    call sites log the *shape* of an event now, and `diagnostics/log.ts` scrubs
    URLs centrally so the next careless line cannot undo it. Worth knowing that
    a sentence in a docblock did not prevent it; the choke point is what does.

    `owner_install_id` is nullable and unindexed on purpose: it correlates
    several reports from one device while a bug is being chased, and a report
    from a client that has not got an identity yet is still worth having. It
    intentionally does not reference `installs.id` — a report must survive the
    install being forgotten, and losing crash history to a foreign key is a poor
    trade.
    """

    __tablename__ = "client_errors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # 'web' or 'android'. Free text rather than an enum: a new client should be
    # able to report before the server has been taught about it.
    platform: Mapped[str] = mapped_column(String(32))
    message: Mapped[str] = mapped_column(Text)
    stack: Mapped[str | None] = mapped_column(Text, nullable=True)
    # What the user says they were doing. The most useful field in the row and
    # the only one a person wrote.
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    app_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    os_version: Mapped[str | None] = mapped_column(String(64), nullable=True)
    device: Mapped[str | None] = mapped_column(String(200), nullable=True)
    owner_install_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    # 'error', 'warn' or 'info' (#322). The table started life holding crashes
    # only, and now also holds the device's rolling log — an import that failed,
    # a track that would not play, a request that never came back. Same row
    # shape, same reader, one place to look; the level is what separates "the
    # app died" from "here is what it was doing beforehand". Free text for the
    # same reason `platform` is, and defaulted so every pre-#322 row reads as
    # what it was: an error.
    level: Mapped[str] = mapped_column(String(16), default="error", server_default="error")
    # What the client called this entry, so a re-sent batch cannot store it
    # twice (#322). The device clears its log only once the server has
    # acknowledged the upload, which means a reply lost in transit is *always*
    # followed by the same entries being sent again — dedupe is the mechanism
    # that makes retrying safe rather than an optimisation.
    #
    # Nullable because the crash path (`POST /client-errors`) has no use for
    # one: it fires once, from a client that may be seconds from being killed,
    # and asking it to mint an id first is work in the worst possible moment.
    # SQLite's UNIQUE ignores NULLs, so any number of those coexist.
    client_key: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)

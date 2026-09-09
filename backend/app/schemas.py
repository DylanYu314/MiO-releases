import enum
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field

from app.failures import classify_failure
from app.models import ImportStatus, PlaylistImportStatus, TrackMatchStatus


class SongSortField(enum.StrEnum):
    ADDED_AT = "added_at"
    TITLE = "title"
    ARTIST = "artist"
    DURATION = "duration"


class SortOrder(enum.StrEnum):
    ASC = "asc"
    DESC = "desc"


class JobCreate(BaseModel):
    url: str


class JobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source_url: str
    status: ImportStatus
    progress: int | None
    song_id: int | None
    error: str | None
    created_at: datetime
    updated_at: datetime

    @computed_field
    @property
    def error_code(self) -> str | None:
        """Why it failed, as a code a client can translate (#177).

        Derived from `error` rather than stored, so improving the rules improves
        every job ever recorded. See `app/failures.py`.
        """
        return classify_failure(self.error)


class SearchResultRead(BaseModel):
    """A single search hit — enough to show a row and start an import from it."""

    model_config = ConfigDict(from_attributes=True)

    url: str
    title: str
    uploader: str | None
    duration: float | None
    # Public and signed by the source, so a client fetches it directly with none
    # of our headers (#312).
    thumbnail: str | None = None


class Page[T](BaseModel):
    """Envelope for paginated list endpoints."""

    items: list[T]
    total: int
    limit: int
    offset: int


class SongRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    artist: str
    album: str | None
    duration: float | None
    source_url: str
    source_platform: str
    added_at: datetime
    # Null until analysed, and for silent files. The client falls back to no
    # correction rather than guessing.
    loudness_lufs: float | None = None
    peak_dbfs: float | None = None
    # Set once a device confirmed it holds the audio and the server deleted its
    # copy (#221). A client seeing this knows `/audio` will answer 410, so it
    # can say "on your phone" rather than offering a play button that fails.
    audio_released_at: datetime | None = None


class SongUpdate(BaseModel):
    """Editable song metadata. Omitted fields are left unchanged."""

    title: str | None = Field(default=None, min_length=1, max_length=500)
    artist: str | None = Field(default=None, min_length=1, max_length=500)
    album: str | None = Field(default=None, max_length=500)


class SpotifyAccountRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    spotify_user_id: str
    display_name: str | None
    created_at: datetime


class SpotifyStatusRead(BaseModel):
    """Connection state for the import page. `configured` is false when the
    server has no SPOTIFY_CLIENT_ID, which the client renders differently
    from "configured but nobody has connected yet"."""

    configured: bool
    accounts: list[SpotifyAccountRead]


class SpotifyPlaylistRead(BaseModel):
    id: str
    name: str
    image_url: str | None
    track_count: int
    owner_name: str | None


class GoogleStatusRead(BaseModel):
    """Connection state for the import screen (#106).

    Three states, not two, and the client renders each differently:
    `configured=False` means the server has no Google credentials at all;
    configured with `channel_title=None` means nobody has connected yet; and a
    channel title means it is ready. Collapsing the first two would tell a user
    to "connect your account" on a server that cannot complete the flow.
    """

    configured: bool
    channel_id: str | None = None
    channel_title: str | None = None
    connected_at: datetime | None = None


class GooglePlaylistRead(BaseModel):
    id: str
    title: str
    track_count: int
    # "private", "public" or "unlisted". Carried because private playlists are
    # the entire reason this feature exists, and a list that cannot say which
    # ones those are hides the point of it.
    privacy: str | None


class GoogleTrackRead(BaseModel):
    """One video for the device to fetch itself.

    A video id and a title, and deliberately nothing else: there is no matching
    step here (#106), because a private playlist hands back exact videos. The
    phone turns each of these into the same download a pasted link performs.
    """

    video_id: str
    title: str
    channel_title: str | None


class PlaylistImportCreate(BaseModel):
    account_id: int
    # A Spotify playlist id, or the sentinel "liked" for Liked Songs.
    playlist_id: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=300)
    # The client will supply the YouTube candidates itself (#353).
    #
    # Optional and defaulting to false, so the web client is unchanged and keeps
    # server-side matching. The phone sends true, because only a residential
    # address can search YouTube at all — see the column's note in `models.py`.
    client_matches: bool = False


class PlaylistImportRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    service: str
    account_id: int | None
    external_playlist_id: str
    name: str
    status: PlaylistImportStatus
    track_count: int | None
    matched_count: int
    import_total: int | None
    imported_count: int
    failed_count: int
    playlist_id: int | None
    error: str | None
    # Exposed so a client can tell whose job the matching is (#353). Without it
    # the phone cannot distinguish an import it must supply candidates for from
    # one the server is already matching — and guessing wrong means either a
    # run that waits forever or two matchers writing over each other.
    client_matches: bool
    created_at: datetime
    updated_at: datetime


class ConfirmImportRequest(BaseModel):
    """Body for `POST /playlist-imports/{id}/confirm` (#268).

    `download: false` means the client will fetch the audio itself, so the
    server accepts the matches and enqueues nothing. Optional and defaulting to
    true, so every existing caller — the web client included — is unchanged.
    """

    download: bool = True


class CandidateRead(BaseModel):
    url: str
    title: str
    uploader: str | None
    duration: float | None
    # Defaulted, because candidates stored before #312 have no such key and a
    # review screen must still open on them.
    thumbnail: str | None = None
    # None when the candidate wasn't produced by matching — a YouTube-playlist
    # entry is its own candidate and carries no machine score (ADR-010).
    score: float | None
    # Defaulted for the same reason as `thumbnail`: candidates stored before
    # #551 have no such key and a review screen must still open on them.
    source: str = "youtube"


class TrackMatchRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    position: int
    external_id: str | None
    title: str
    artist: str
    album: str | None
    duration_s: float | None
    candidates: list[CandidateRead]
    chosen_url: str | None
    confidence: float | None
    status: TrackMatchStatus
    import_job_id: int | None
    song_id: int | None
    error: str | None

    @computed_field
    @property
    def error_code(self) -> str | None:
        """Why this track failed, as a translatable code (#177)."""
        return classify_failure(self.error)


class TrackMatchUpdate(BaseModel):
    """Review actions on one match. Omitted fields are left unchanged."""

    status: Literal["accepted", "rejected"] | None = None
    # Any candidate's URL, or a pasted custom one — yt-dlp takes anything.
    chosen_url: str | None = Field(default=None, min_length=1, max_length=2000)


class AccessStatusRead(BaseModel):
    """Whether importing is gated on this server, and whether the caller's key
    (the X-Unlock-Key header) currently unlocks it — so the UI can show a lock
    instead of failing a request (ADR-009)."""

    locked: bool
    unlocked: bool
    # Whether this key may read everyone's diagnostics (#354). Independent of
    # `unlocked`, not implied by it: every tester is unlocked and almost none
    # are administrators. Defaulted so a client written against the older shape
    # keeps parsing the response.
    admin: bool = False


class SearchResultIn(BaseModel):
    """One candidate a client found for a track (#353).

    Mirrors `ytdlp.SearchResult`, which is what the scorer takes — the point of
    this endpoint is that the *search* moved to the device and the *scoring* did
    not, so the shape crossing the wire is the shape the scorer already reads.

    Everything is bounded, because this is now an input where it used to be
    something the server produced for itself. A client is not a trusted source
    of strings just because it is our own client.
    """

    url: str = Field(min_length=1, max_length=500)
    title: str = Field(min_length=1, max_length=500)
    uploader: str | None = Field(default=None, max_length=300)
    duration: float | None = Field(default=None, ge=0)
    thumbnail: str | None = Field(default=None, max_length=1000)
    # Which platform the client searched (#551). A closed set, unlike
    # `ExternalPlaylistCreate.service`: this one *changes scoring*, so an
    # unrecognised value must be rejected rather than quietly treated as
    # neither — see `_is_topic_channel`. Defaulted so the web client, which
    # searches YouTube only, is unchanged.
    source: Literal["youtube", "bilibili"] = "youtube"


class TrackCandidatesIn(BaseModel):
    """The candidates a client found for one track."""

    match_id: int
    # An empty list is meaningful and allowed: it says "I searched and found
    # nothing", which is what marks the row `no_match` rather than leaving it
    # pending forever.
    results: list[SearchResultIn] = Field(default_factory=list, max_length=20)


class CandidatesSubmission(BaseModel):
    """Body for `POST /playlist-imports/{id}/candidates` (#353).

    A batch rather than one request per track: a playlist is routinely forty
    long, and forty round trips over a phone connection is the difference
    between an import that feels immediate and one that does not.
    """

    tracks: list[TrackCandidatesIn] = Field(min_length=1, max_length=200)


class YouTubePlaylistImportCreate(BaseModel):
    """Start an import from a public YouTube playlist URL (ADR-010). No Spotify
    account and no API key — yt-dlp reads the playlist directly."""

    url: str = Field(min_length=1, max_length=2000)


class ExternalTrackIn(BaseModel):
    """One track of a track list the client fetched for itself (ADR-013).

    The same fields `TrackMatch` already stores, because that is what this
    becomes. Bounded exactly like `SearchResultIn` above, and for the same
    reason: a client is not a trusted source of strings just because it is our
    own client.
    """

    # The track's id at its source, kept so a re-import can recognise a row.
    # Optional because not every source has a stable one worth carrying.
    external_id: str | None = Field(default=None, max_length=100)
    title: str = Field(min_length=1, max_length=500)
    # `TrackMatch.artist` is NOT NULL, and an empty artist is a real answer
    # rather than a missing one — Kugou glues artist and title into a single
    # `filename` and the split can fail. It costs the track its chance of
    # auto-matching (see ADR-013 decision 3), which is the correct outcome.
    artist: str = Field(default="", max_length=500)
    album: str | None = Field(default=None, max_length=500)
    duration_s: float | None = Field(default=None, ge=0)


class ExternalPlaylistImportCreate(BaseModel):
    """Body for `POST /playlist-imports/external` (ADR-013).

    NetEase, QQ Music and Kugou hand back **titles and artists**, so each track
    still has to be found on YouTube — this is the Spotify pipeline, entered one
    phase later. The device has already done the fetching, because these are
    undocumented endpoints on Chinese services and the connection that should
    reach a user's music service is the user's own (ADR-013 decision 2).

    `service` is a free-form slug rather than an enum on purpose: adding a fourth
    source should be a change to the app, which ships over the air in a minute
    (#412), not a droplet deploy. Nothing downstream branches on it — it is a
    label for display, and `confirm` is service-agnostic.
    """

    service: str = Field(pattern=r"^[a-z][a-z0-9_]{0,31}$")
    # The playlist's URL at its source, stored as `external_playlist_id` the way
    # a YouTube import stores its URL there (ADR-010).
    source_url: str = Field(min_length=1, max_length=2000)
    name: str = Field(min_length=1, max_length=300)
    # Bounded to keep one request from becoming an unbounded write. 5000 is a
    # body limit, not a product one: the largest playlist measured while writing
    # ADR-013 was 3232 tracks (QQ Music, returned in a single response), so a
    # tighter cap would reject real playlists.
    tracks: list[ExternalTrackIn] = Field(min_length=1, max_length=5000)


class TrackMatchBulkUpdate(BaseModel):
    """Accept or reject many matches at once. Repointing a URL stays per-row —
    a single URL can't be right for a whole selection."""

    match_ids: list[int] = Field(min_length=1)
    status: Literal["accepted", "rejected"]


class PlaylistCreate(BaseModel):
    name: str = Field(min_length=1, max_length=300)


class PlaylistUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=300)


class PlaylistRead(BaseModel):
    """A playlist without its contents — used for list views."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    kind: str
    item_count: int
    created_at: datetime
    updated_at: datetime


class PlaylistItemRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    position: int
    song: SongRead


class PlaylistDetail(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    kind: str
    created_at: datetime
    updated_at: datetime
    items: list[PlaylistItemRead]


class PlaylistItemCreate(BaseModel):
    song_id: int


class FavouriteSongIds(BaseModel):
    """Just the ids, so the UI can render a heart per row without shipping the
    whole favourites playlist to every list view."""

    song_ids: list[int]


class PlaylistReorder(BaseModel):
    """Full new ordering — must contain exactly the playlist's existing item ids."""

    item_ids: list[int]


class ClientErrorCreate(BaseModel):
    """A crash report, or one line of a client's rolling log (P9, #322).

    Every field except `platform` and `message` is optional, deliberately: a
    client reporting a crash is by definition in a bad state, and a report that
    is rejected for missing its OS version is worth less than a partial one that
    arrives.
    """

    platform: str = Field(min_length=1, max_length=32)
    message: str = Field(min_length=1, max_length=4000)
    stack: str | None = Field(default=None, max_length=20000)
    # What the user says they were doing — the only field a person wrote, and
    # usually the most useful one in the row.
    description: str | None = Field(default=None, max_length=2000)
    app_version: str | None = Field(default=None, max_length=64)
    os_version: str | None = Field(default=None, max_length=64)
    device: str | None = Field(default=None, max_length=200)
    # Defaulted rather than required, so a client written against the pre-#322
    # endpoint keeps working unchanged and its reports still read as errors.
    level: str = Field(default="error", min_length=1, max_length=16)
    # The client's own name for this entry, used to dedupe a re-sent batch.
    client_key: str | None = Field(default=None, max_length=64)


class ClientErrorBatch(BaseModel):
    """A day of one device's log, uploaded in one request (#322).

    Capped at 500 entries because that is the device's own log ceiling: a client
    that sends more than a full log is either broken or not ours, and either way
    a bounded request is what keeps an ungated endpoint affordable.
    """

    items: list[ClientErrorCreate] = Field(min_length=1, max_length=500)


class ClientErrorBatchResult(BaseModel):
    """What the device needs in order to decide it can clear its log.

    `stored + duplicates == len(items)` is the acknowledgement: everything sent
    is now on the server, whether this request is what put it there or a
    previous one whose reply was lost.
    """

    stored: int
    duplicates: int


class ClientErrorRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    platform: str
    message: str
    stack: str | None
    description: str | None
    app_version: str | None
    os_version: str | None
    device: str | None
    level: str
    # Which install sent it (#354). The developer view needs to tell one tester
    # from another, and `device` cannot — two people on the same phone model are
    # indistinguishable without it.
    #
    # Safe to expose: this is the `installs` row id, an integer, not the token
    # the client holds. That is stored hashed and is never returned by anything.
    owner_install_id: int | None
    created_at: datetime

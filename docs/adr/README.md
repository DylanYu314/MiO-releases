# Architecture decisions

One file per decision that was expensive to make, written as it was made rather
than afterwards. The value is not the record — it is that writing the
**Consequences** section catches a bad decision before it ships.

Format: Status → Context → Decision → Consequences → Related.

⚠️ **A superseded ADR is kept, not deleted.** The reasoning for a choice that
later turned out wrong is usually the most useful thing in the file, and
deleting it makes the same mistake available again.

| | Decision | Status | |
|---|---|---|---|
| **001** | [Local-first, server-optional architecture](./0001-architecture-overview.md) | Accepted | 2026-07-22 |
| **002** | [Tech stack choices](./0002-tech-stack-choices.md) | Accepted | 2026-07-22 |
| **003** | [Frontend architecture and tooling](./0003-frontend-architecture.md) | Accepted | 2026-07-22 |
| **004** | [In-process job event broker for live progress](./0004-in-process-job-event-broker.md) | ⛔ Superseded | 2026-07-22 |
| **005** | [Spotify playlist import under the 2026 dev-mode constraints](./0005-spotify-playlist-import.md) | Accepted | 2026-07-23 |
| **006** | [Celery + Redis for background work](./0006-celery-redis-job-queue.md) | Accepted | 2026-07-23 |
| **007** | [Theme tokens and a class-based dark mode](./0007-theme-tokens-and-dark-mode.md) | Accepted | 2026-07-23 |
| **008** | [Internationalization with i18next](./0008-internationalization.md) | Accepted | 2026-07-23 |
| **009** | [Managed access keys for import entrypoints](./0009-managed-access-keys.md) | Accepted | 2026-07-24 |
| **010** | [YouTube public-playlist import](./0010-youtube-playlist-import.md) | Accepted | 2026-07-24 |
| **011** | [A two-tier playback queue](./0011-two-tier-playback-queue.md) | Accepted | 2026-07-24 |
| **012** | [A Web Audio processing graph](./0012-web-audio-graph.md) | 📜 Historical | 2026-07-25 |
| **013** | [Importing playlists from NetEase, QQ Music and Kugou](./0013-chinese-platform-playlist-imports.md) | Accepted | 2026-08-16 |
| **014** | [Importing private YouTube playlists](./0014-private-youtube-playlist-import.md) | Accepted | 2026-08-13 |
| **015** | [Android app architecture (Expo, expo-router, expo-audio)](./0015-android-app-architecture.md) | Accepted | 2026-07-25 |
| **016** | [Sharing code between the web client and the Android app](./0016-sharing-code-across-web-and-native.md) | Accepted | 2026-07-25 |
| **017** | [Releasing the server's audio once a device confirms it has the file](./0017-releasing-server-audio-once-a-device-has-it.md) | Accepted | 2026-08-06 |
| **018** | [How a gesture composes with a scroll view](./0018-gestures-inside-scroll-views.md) | Accepted | 2026-08-05 |
| **019** | [Work that outlives the screen going off](./0019-work-that-outlives-the-screen.md) | Accepted | 2026-08-07 |
| **020** | [The server is optional](./0020-the-server-is-optional.md) | Accepted | 2026-08-19 |
| **021** | [The phone is the library's origin, and the droplet never holds audio](./0021-the-phone-is-the-origin.md) | ⚠️ Amended | 2026-09-08 |

## The ones to read first

If you are new to the codebase and only read three:

- **[ADR-020](./0020-the-server-is-optional.md)** — why the Android app needs no
  server at all, and why that was forced rather than chosen.
- **[ADR-021](./0021-the-phone-is-the-origin.md)** — where a library lives, and
  why audio never moves between devices.
- **[ADR-015](./0015-android-app-architecture.md)** — how the app is put
  together.

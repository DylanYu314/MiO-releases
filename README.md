# MiO — downloads

**[⬇ Download the latest APK](https://github.com/DylanYu314/MiO-releases/releases/latest)**

MiO is a local-first music library manager for Android. Your music is stored on
your phone. There is no account, no server, and nothing to sign up for.

This repository holds **releases only** — the app's source is not here.

## Installing

- **Android 7.0 (Nougat) or newer.** Every ABI is included, so 32-bit devices
  work too.
- Android will warn you about **installing from unknown sources**, and the
  warning is correct: this is not from an app store. You will need to allow it
  for your browser or file manager. Nothing has gone wrong.
- Installing over an earlier MiO keeps your library.

MiO is not on Google Play or the App Store, and will not be — both stores
prohibit what it does.

## Updates

Most fixes arrive **silently**: the app checks on launch, downloads in the
background and applies on the next start. Fixes that change native code need a
new APK from here, and the app will tell you when one exists.

## What it does not do

- It does not sell anything. Donations, if any, grant **nothing** — no key, no
  tier, no feature.
- It does not send your library, your listening, or your identity anywhere.
- It does not distribute audio between users. Your phone fetches its own.

Free software under [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html).

---

`version.json` in this repository is what the app reads to discover a new
release. It is generated from the APK itself, so it cannot disagree with it.

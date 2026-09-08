# MiO — downloads

**[⬇ Download the latest APK](https://github.com/DylanYu314/MiO-releases/releases/latest)**

MiO is a local-first music library manager for Android. Your music is stored on
your phone. There is no account, no server, and nothing to sign up for.

This repository holds **releases only** — the app's source is not here.

## 中国大陆用户请看 / Downloading from mainland China

GitHub 的**页面**可以打开，但点击 Assets 里的附件**下载会失败**——附件由
`githubusercontent.com` 提供，该域名在中国大陆无法访问。`dl.dlany.uk` 同样无法访问。

请改用下面这个地址下载（已由中国大陆用户实测，69 MB 可完整下载）：

**https://pub-6eb86219220840aa84b5dd9ecde0059c.r2.dev/MiO-v1.0.1.apk**

装好之后，应用内的更新检查也走这个地址，所以后续更新可以正常收到。

> The GitHub release **page** loads from mainland China, but the **asset
> download does not** — assets are served from `githubusercontent.com`, which is
> blocked there, as is `dl.dlany.uk`. Use the link above instead; it is the same
> file, and it has been verified downloading in full from mainland China. The
> app's own update check uses that host too, so updates keep working afterwards.

## Where to download

Every link below is the **same file**, byte for byte.

| source | reachable from mainland China |
|---|---|
| [`pub-…r2.dev`](https://pub-6eb86219220840aa84b5dd9ecde0059c.r2.dev/MiO-v1.0.1.apk) | ✅ yes — measured |
| [`dl.dlany.uk`](https://dl.dlany.uk/MiO-v1.0.1.apk) | ❌ no |
| [GitHub release asset](https://github.com/DylanYu314/MiO-releases/releases/latest) | ❌ no (page loads, download fails) |

## Installing

- **Android 7.0 (Nougat) or newer.** Both 64-bit and 32-bit ARM devices are
  supported. (Emulator-only x86 builds were dropped in 1.0.1 to halve the
  download; no phone could run them.)
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

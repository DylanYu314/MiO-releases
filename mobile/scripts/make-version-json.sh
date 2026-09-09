#!/usr/bin/env bash
#
# Write the `version.json` that the app's update check reads (#665).
#
#   ./scripts/make-version-json.sh build-1787312078720.apk > version.json
#
# ## Why this is generated rather than written by hand
#
# My objection to a hand-written manifest was that it can drift from the
# release it describes — nothing stops a file saying `1.1.0` while the APK next
# to it is `1.0.0`, and the failure mode is an app that nags every user forever
# about an update that does not exist.
#
# So the version is **read out of the APK** with `aapt2`, not passed in. The
# manifest cannot disagree with the artefact because it is derived from it.
#
# ## ⚠️ Why this is a shell script under `scripts/`
#
# Same reason as `build-local.sh`: `mobile/scripts/` is hashed by nothing, while
# an npm script lives in `packageJson:scripts` and a config plugin in
# `plugins/` — both fingerprint sources (`docs/native-rebuild.md`). A convenience
# for cutting a release must never move the runtime version, or it would decide
# which binaries an over-the-air update can reach.

set -euo pipefail

APK="${1:-}"
if [ -z "$APK" ] || [ ! -f "$APK" ]; then
  echo "usage: $0 <path-to-apk> [download-url-base]" >&2
  exit 2
fi

REPO="${MIO_RELEASES_REPO:-DylanYu314/MiO-releases}"

AAPT2="$(ls -1 "${ANDROID_HOME:-$HOME/Android/Sdk}"/build-tools/*/aapt2 2>/dev/null | sort -V | tail -1 || true)"
if [ -z "$AAPT2" ]; then
  echo "No aapt2 found under \$ANDROID_HOME/build-tools — see docs/native-rebuild.md" >&2
  exit 1
fi

BADGING="$("$AAPT2" dump badging "$APK")"
VERSION_NAME="$(sed -n "s/.*versionName='\([^']*\)'.*/\1/p" <<<"$BADGING" | head -1)"
VERSION_CODE="$(sed -n "s/.*versionCode='\([^']*\)'.*/\1/p" <<<"$BADGING" | head -1)"

if [ -z "$VERSION_NAME" ]; then
  echo "Could not read versionName from $APK — is it a valid APK?" >&2
  exit 1
fi

# ⚠️ A release APK must carry every ABI. The default of `build-local.sh` is
# arm64 only, which is right for testing and would leave a 32-bit phone with
# nothing to install and no explanation. Refuse to describe such a build as a
# public release rather than discovering it from a user.
NATIVE="$(sed -n 's/^native-code: //p' <<<"$BADGING" | head -1)"
# ⚠️ Only the ABIs a *phone* can run are required (#725).
#
# This used to demand all four and refuse anything else, which was right while
# `--all-abis` was the release build. It is not any more: x86 and x86_64 exist
# only on emulators and were 47 MB of the 116 MB v1.0.0, so `--release` drops
# them. Left as it was, this guard would have blocked the release it exists to
# describe.
#
# ⛔ arm64-v8a alone is still not enough. Some budget and older devices are
# 32-bit, and an APK without armeabi-v7a silently has nothing to install on
# them — the same warning `build-local.sh` carries.
for abi in arm64-v8a armeabi-v7a; do
  case "$NATIVE" in
    *"$abi"*) ;;
    *)
      echo "✗ $APK is missing the $abi ABI (has: $NATIVE)." >&2
      echo "  Rebuild with ./scripts/build-local.sh --release before releasing." >&2
      exit 1
      ;;
  esac
done

ASSET="MiO-v${VERSION_NAME}.apk"

# Where the APK will actually be downloadable from.
#
# ⚠️ This argument was documented in the usage line from the start and never
# implemented — the URL below was hardcoded to GitHub, so passing a base did
# nothing and said nothing (#725). It matters now: GitHub is blocked in mainland
# China, so releases are served from R2 at `dl.dlany.uk`, and the manifest has to
# point there or a Chinese user is told about an update they cannot fetch.
#
# GitHub stays the canonical archive; it is simply no longer what the app reads.
BASE="${2:-}"
if [ -n "$BASE" ]; then
  URL="${BASE%/}/${ASSET}"
else
  URL="https://github.com/${REPO}/releases/download/v${VERSION_NAME}/${ASSET}"
fi

# `versionCode` is included for humans and future use; the app compares
# `versionName`, because that is what `Constants.expoConfig.version` gives it
# without the new native module `expo-application` would have cost (#665).
cat <<JSON
{
  "versionName": "${VERSION_NAME}",
  "versionCode": ${VERSION_CODE},
  "url": "${URL}"
}
JSON

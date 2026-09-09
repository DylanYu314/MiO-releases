#!/usr/bin/env bash
#
# Build the Android APK on this machine instead of on EAS.
#
# The EAS free plan is 15 Android builds a month. This one costs nothing and is
# not counted — measured 2026-08-14 by running it while the plan was exhausted
# and a cloud build was being refused at submission.
#
#   ./scripts/build-local.sh              # arm64 only — for your phone
#   ./scripts/build-local.sh --release    # every real device — for a release
#   ./scripts/build-local.sh --all-abis   # + x86 emulators. Rarely what you want
#
# ## Why the default is arm64-v8a alone
#
# `reactNativeArchitectures` defaults to all four ABIs, so every dependency with
# native code — expo-updates, reanimated, worklets, gesture-handler, sqlite — is
# compiled *four times*. Restricting it is the single biggest lever on local
# build time, and every phone worth testing on is arm64.
#
# It is a Gradle **project property** (`ProjectUtils.getReactNativeArchitectures`
# reads it through `project.hasProperty`), which is why this is an environment
# variable and not a config plugin: Gradle maps `ORG_GRADLE_PROJECT_<name>` onto
# a project property, so nothing in the repo has to change to set it.
#
# ⚠️ **That last part is the point.** A config plugin would live in `plugins/`,
# which *is* a fingerprint source, and an npm script would live in
# `packageJson:scripts`, which is *also* one — measured, see
# `docs/native-rebuild.md`. Either would change the runtime version, so a
# convenience for building would quietly decide which binaries an
# over-the-air update can reach. A shell script under `scripts/` is hashed by
# nothing.
#
# ⚠️ **Do not ship an arm64-only APK to the download page.** Some budget and
# older devices are still 32-bit and would silently have no build to install.
#
# ## `--release` is what a stranger should download, not `--all-abis`
#
# v1.0.0 shipped `--all-abis` at **116 MB**, and 47 MB of that is x86 and
# x86_64 — ABIs that only exist on emulators. No Android phone can use them.
# Dropping the two costs **nothing** in device coverage and takes roughly 41%
# off the download, which matters most on exactly the constrained links this is
# hardest for (#725: China reaches the release over a 200 ms path).
#
# Measured from v1.0.0's own APK rather than estimated — uncompressed `lib/`
# per ABI, checked against the two builds whose compressed sizes were known:
#
#     arm64-v8a            22.8 MB      arm64 only            52 MB  (measured)
#     armeabi-v7a          15.8 MB      arm64 + armeabi-v7a  ~68 MB
#     x86                  24.0 MB      all four             116 MB  (measured)
#     x86_64               23.4 MB
#
# Native libraries barely compress, which is why the per-ABI figures carry
# across almost unchanged and the model predicts both known builds.

set -euo pipefail

cd "$(dirname "$0")/.."

ABIS="arm64-v8a"
for arg in "$@"; do
  case "$arg" in
    # Every real device and nothing else. See the note above.
    --release) ABIS="arm64-v8a,armeabi-v7a" ;;
    --all-abis) ABIS="" ;;
    -h | --help)
      sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

# JDK 17, not the JDK 23 sdkman has as `current`:
# @react-native/gradle-plugin pins AGP 8.12, which does not support 23.
JDK17="$HOME/.sdkman/candidates/java/17.0.20-tem"
if [ -d "$JDK17" ]; then
  export JAVA_HOME="$JDK17"
  export PATH="$JAVA_HOME/bin:$PATH"
fi

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"

if [ ! -d "$ANDROID_HOME/platform-tools" ]; then
  echo "No Android SDK at $ANDROID_HOME — see docs/native-rebuild.md" >&2
  exit 1
fi

if [ -n "$ABIS" ]; then
  export ORG_GRADLE_PROJECT_reactNativeArchitectures="$ABIS"
  echo "Building for $ABIS only. Use --all-abis for a public release APK."
else
  echo "Building every ABI. Slow — this is the setting for the download page."
fi

echo "JAVA_HOME=$JAVA_HOME"
echo
echo "⚠️  This is 25-40 minutes of heavy CPU. Run ONE at a time — two at once"
echo "    will cook the machine. To stop it: pkill -f eas-cli-local-build-plugin"
echo

# Not "$@" — the flags above are this script's, and `eas` would reject them.
npx eas build --profile production --platform android --local

# ---------------------------------------------------------------------------
# Verify the config plugins actually reached the binary (#523).
#
# On 2026-08-14 a local build produced an APK with **neither** config plugin
# applied, and said nothing: mono answered `no_processor` and Bluetooth
# next/previous stopped working, both silently, on an APK that built and ran.
# The cause was that `expo-audio` ships as a **prebuilt AAR** (SDK 54+), so
# prebuild patched a source tree Gradle never compiled. The fix is
# `expo.autolinking.buildFromSource` in `package.json`; this check is what
# proves it is still in force, since the failure it guards is silent.
#
# That is the whole lesson of #478, where `patch-package` shipped an unpatched
# APK because it ran everywhere except on the build server: a native patch that
# can fail quietly *will* fail quietly, and the check belongs next to the build.
#
# `MioMonoAudioProcessor` is #482's injected class and is detectable by name.
# #473's patch only *modifies* expo-audio, so it leaves no name to look for —
# but both plugins run in the same prebuild pass, so this stands in for both.
# ⚠️ That is a proxy, not proof, and the Bluetooth check on a device is still
# the only real test of #473.
#
# ## Why there is a control
#
# The first version of this check hid `unzip`'s stderr and asked one question,
# so *every* way of failing to read the APK came out as "the plugins are
# missing". It then cried wolf on a build that was in fact correct — the same
# fault in the other direction as the bug it guards. An unreadable or
# half-written APK now reports itself as that, because `MioEqualizerModule`
# (from `modules/`, which no config plugin touches) must be found too: if the
# control is missing, the answer is about the *reading*, not about the plugins.
# ---------------------------------------------------------------------------

APK="$(ls -t build-*.apk 2>/dev/null | head -1 || true)"
if [ -z "$APK" ]; then
  echo "No build-*.apk found — nothing to verify." >&2
  exit 1
fi

echo
echo "Verifying config plugins landed in $APK …"

# One pass over the dex, so the control and the subject are read from the same
# bytes — two `unzip` runs could disagree about a file still being written.
SYMBOLS="$(mktemp)"
trap 'rm -f "$SYMBOLS"' EXIT

if ! unzip -p "$APK" 'classes*.dex' | strings > "$SYMBOLS"; then
  echo "✗ Could not read $APK — see unzip's error above. Nothing was verified." >&2
  exit 1
fi

if ! grep -q 'MioEqualizerModule' "$SYMBOLS"; then
  cat >&2 <<WARN

✗ CANNOT VERIFY $APK

  MioEqualizerModule is absent too, and no config plugin touches it. So this
  says the APK could not be read properly — truncated, still being written, or
  not the file you think it is — and says nothing about the plugins.

  Re-run this check by hand once the build has settled:
    unzip -p $APK 'classes*.dex' | strings | grep -c MioMonoAudioProcessor
WARN
  exit 1
fi

if grep -q 'MioMonoAudioProcessor' "$SYMBOLS"; then
  echo "✓ Config plugins applied — mono (#482) is in the binary."
else
  cat >&2 <<'WARN'

✗ CONFIG PLUGINS DID NOT APPLY (#523)

  MioMonoAudioProcessor is absent from the APK's dex, which means
  plugins/withMonoAudioProcessor.js did not reach the binary — and
  withSinglePlayerMediaSession.js (#473) almost certainly did not either.

  Check `expo.autolinking.buildFromSource` in package.json still lists
  expo-audio: without it Gradle links the prebuilt AAR and every patch
  prebuild makes to expo-audio's Kotlin is discarded (#523).

  This APK will have:
    - mono silently doing nothing        (diagnostics: mono.refused no_processor)
    - Bluetooth/headset next & previous  going to expo-audio's session instead

  It is otherwise a working build. Install it if you need to, but do not
  treat mono or hardware media buttons as tested on it.
WARN
  exit 1
fi

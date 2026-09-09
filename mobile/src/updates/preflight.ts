/**
 * Will an `eas update` from this tree actually reach the installed app? (#418)
 *
 * ## Why this exists
 *
 * On 2026-08-10 a publish succeeded, reported a runtime version, and reached
 * nothing. The APK had been built from `e29fed5`; `#414` then added one line to
 * `app.json` — `"platforms": ["android"]` — and `app.json` is fingerprint input,
 * so the runtime version moved and the phone stayed where it was. `eas update`
 * says `Published!` either way: it is publishing to a *runtime version*, and it
 * has no idea which binaries exist.
 *
 * The failure is silent by design. `fallbackToCacheTimeout: 0` means the app
 * never blocks on a download, so a bundle that cannot apply is indistinguishable
 * from one that has not arrived yet — which is indistinguishable from a fix that
 * did not work. Three states, one appearance.
 *
 * `docs/history/device-check-2026-08-10.md` did say *"Merge #414 first"*. It was read,
 * and the build still ran from the wrong tree, because a sentence in a document
 * is not a mechanism — the same lesson #357 cost this project ("a 'do not merge
 * yet' note in a PR body is not a mechanism").
 *
 * ## Why the comparison is a pure function
 *
 * Everything interesting here is a string comparison and the sentence it
 * produces. Fetching the build list needs the network and an EAS session, and
 * computing a fingerprint shells out to `expo-updates` — neither belongs
 * anywhere near a test. So the decision lives here and `scripts/ota-check.mjs`
 * is the shell around it, the same split as `app/ytdlp.py` on the backend.
 */

/**
 * Where a build came from, and therefore how much it is worth (#536).
 *
 * ⚠️ **`device` is the only one that is a fact.** The others are inferences
 * about which binary someone installed, and on 2026-08-14 that inference went
 * wrong in the worst possible direction: EAS's free plan ran out, builds moved
 * to `scripts/build-local.sh`, and `eas build:list` — which never sees a local
 * build — kept confidently naming a cloud build from days earlier. The check
 * said "this update will NOT reach the installed app" about an update that
 * did, twice, and the answer was to ignore the tool.
 *
 * A check that is wrong is worse than no check, because the habit it teaches is
 * to override it.
 */
export type BuildOrigin =
  /** Read out of the APK that is installed on an attached phone. Ground truth. */
  | 'device'
  /** An APK built by `scripts/build-local.sh` and sitting in `mobile/`. It was
   *  probably installed by hand; nothing here proves it. */
  | 'local'
  /** From `eas build:list`. Real, and invisible to local builds. */
  | 'eas'

/** The one thing about an installed binary that decides what can reach it. */
export interface KnownBuild {
  /** The EAS build id, or the APK's filename — whatever names it to a human. */
  id: string
  origin: BuildOrigin
  /** The channel it listens on. A build on another channel never sees this
   *  publish however well the fingerprints match. */
  channel: string | null
  /** Its runtime version — the native fingerprint at the moment it was built.
   *  For a local or device build this is the APK's `assets/fingerprint`, which
   *  is the same string expo-updates serves against. */
  runtimeVersion: string | null
  /** The commit it was built from, which is what makes the advice actionable:
   *  "you built before X landed" is a more useful sentence than two hashes.
   *  Null for a local APK, which records no commit. */
  gitCommitHash: string | null
  /** For ordering when nothing better is known. Epoch milliseconds. */
  builtAt: number | null
}

export interface PreflightInput {
  /** The fingerprint of the working tree, from `expo-updates`. */
  localFingerprint: string
  /** The branch `eas update` would publish to. */
  branch: string
  /** Every build we could find, from any source. */
  builds: readonly KnownBuild[]
}

export type PreflightVerdict =
  /** Fingerprints agree — the bundle is servable to that build. */
  | { kind: 'will-apply'; build: KnownBuild }
  /**
   * A build exists on this channel and its runtime version differs. **This is
   * the case that used to be silent**, and the only one worth interrupting for.
   */
  | { kind: 'will-not-apply'; build: KnownBuild; expected: string }
  /** No finished build listens on this channel, so nothing can receive it —
   *  usually "build first", occasionally a typo'd branch name. */
  | { kind: 'no-build'; branch: string }

/**
 * Which build to judge against, out of everything we found.
 *
 * **A phone beats a guess**, always. If an attached device told us what it is
 * running, that ends the question — nothing inferred can be more true than the
 * binary that is actually installed, and #536 was entirely a case of an
 * inference outranking reality.
 *
 * Failing a device, the newest build wins, and a **local** build outranks a
 * cloud one of the same age: since 2026-08-14 local builds are the ones that
 * get installed here, and EAS cannot see them. Only that one build is
 * considered — reporting on five historical builds would bury the answer in a
 * list nobody reads, which is the failure this whole file exists to prevent.
 */
const RANK: Record<BuildOrigin, number> = { device: 2, local: 1, eas: 0 }

function mostAuthoritative(builds: readonly KnownBuild[]): KnownBuild | undefined {
  return builds.reduce<KnownBuild | undefined>((best, candidate) => {
    if (!best) return candidate
    if (RANK[candidate.origin] !== RANK[best.origin]) {
      return RANK[candidate.origin] > RANK[best.origin] ? candidate : best
    }
    return (candidate.builtAt ?? 0) > (best.builtAt ?? 0) ? candidate : best
  }, undefined)
}

/**
 * Decide whether publishing to `branch` can reach anything.
 *
 * The channel is compared before the fingerprint because it is the coarser
 * mistake: a `development` APK with a matching fingerprint still receives
 * nothing published to `production`, and saying "the fingerprints match" there
 * would be true and completely misleading.
 */
export function preflight({ localFingerprint, branch, builds }: PreflightInput): PreflightVerdict {
  const onChannel = builds.filter((build) => build.channel === branch)
  const chosen = mostAuthoritative(onChannel)
  if (!chosen) return { kind: 'no-build', branch }

  if (chosen.runtimeVersion === localFingerprint) {
    return { kind: 'will-apply', build: chosen }
  }
  return { kind: 'will-not-apply', build: chosen, expected: localFingerprint }
}

/** Whether the verdict should stop a publish. Exported so the script's exit
 *  code and its wording cannot drift apart. */
export const blocksPublish = (verdict: PreflightVerdict): boolean => verdict.kind !== 'will-apply'

const short = (value: string | null | undefined, length = 8) =>
  value ? value.slice(0, length) : '—'

/**
 * The message a human reads, which is the whole product of this file.
 *
 * Deliberately says **what to do**, not only what is wrong. The 2026-08-10
 * failure was not a lack of information — the runtime version was printed twice,
 * in the publish output and on the Diagnostics screen — it was that neither
 * printing said "these two numbers should be equal and are not".
 */
export function describeVerdict(verdict: PreflightVerdict): string {
  switch (verdict.kind) {
    case 'will-apply':
      return [
        `✓ This update will apply.`,
        `  ${sourceOf(verdict.build)} runs ${short(verdict.build.runtimeVersion, 12)}`,
        `  and this tree fingerprints the same.`,
      ].join('\n')

    case 'no-build':
      return [
        `✗ No build listens on "${verdict.branch}".`,
        `  Nothing can receive this update. Either build for that channel, or`,
        `  check the branch name.`,
        ``,
        `  Nothing was found on a device, in mobile/build-*.apk, or on EAS.`,
      ].join('\n')

    case 'will-not-apply':
      return [
        `✗ This update will NOT reach ${
          verdict.build.origin === 'device' ? 'the app on the phone' : 'the installed app'
        }.`,
        ``,
        `  installed  ${short(verdict.build.runtimeVersion, 12)}  (${sourceOf(verdict.build)})`,
        `  this tree  ${short(verdict.expected, 12)}`,
        ``,
        `  The native fingerprint moved after that build, so the bundle is not`,
        `  servable to it — and \`eas update\` would still say "Published!".`,
        ``,
        `  Either rebuild from this tree, or publish from a tree whose native`,
        `  side matches what is installed.`,
        ...(verdict.build.origin === 'device'
          ? []
          : [
              ``,
              `  ⚠️ This is inferred, not read off a phone. Attach one over adb`,
              `     and re-run to be certain — a ${verdict.build.origin} build is only`,
              `     evidence that it was built, not that it was installed.`,
            ]),
      ].join('\n')
  }
}

/**
 * Where this answer came from, said out loud every time.
 *
 * ⚠️ **The whole of #536 was a confident answer from the wrong source.** The
 * check named a cloud build, sounded certain, and was wrong for two days
 * because nothing in its output said "I am guessing which binary you
 * installed". An instrument that cannot express its own confidence teaches
 * people to ignore it the first time it is wrong.
 */
function sourceOf(build: KnownBuild): string {
  switch (build.origin) {
    case 'device':
      return `the phone (${build.id})`
    case 'local':
      return `local APK ${build.id}`
    case 'eas':
      return `EAS build ${short(build.id)}, commit ${short(build.gitCommitHash)}`
  }
}

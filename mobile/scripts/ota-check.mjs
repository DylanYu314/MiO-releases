#!/usr/bin/env node
/**
 * `npm run ota:check` — will a publish from this tree reach the phone? (#418)
 *
 * The IO shell around `src/updates/preflight.ts`, which holds the decision and
 * the wording. Everything here is *finding out what is installed*, from three
 * sources in descending order of truth:
 *
 *   1. **an attached phone** — `assets/fingerprint` read out of the APK that is
 *      actually installed. A fact, not an inference.
 *   2. **`mobile/build-*.apk`** — what `scripts/build-local.sh` produced. Almost
 *      certainly what was installed; nothing here proves it.
 *   3. **`eas build:list`** — real builds, and blind to every local one.
 *
 * ⚠️ **Source 3 alone is what made this tool lie (#536).** When the EAS free
 * plan ran out on 2026-08-14 and builds moved local, `eas build:list` kept
 * confidently naming a cloud build from days before, so the check reported
 * "will NOT reach the installed app" about an update that did reach it — twice.
 * The fix is not a better guess, it is asking the phone.
 *
 * Exits non-zero when a publish would be pointless, so it can be chained:
 *
 *     npm run ota:check && npx eas update --branch production --environment production
 *
 * That chaining is the point. `docs/history/device-check-2026-08-10.md` said "merge
 * #414 first"; it was read, the build ran from the wrong tree anyway, and the
 * publish that followed reported success and reached nothing.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { blocksPublish, describeVerdict, preflight } from '../src/updates/preflight.ts'

const branch = process.argv[2] ?? 'production'
const PACKAGE = 'dev.dylanyu.mio'

/** `execFileSync` rather than a shell: no argument here is ours to quote, and
 *  a branch name off the command line has no business reaching `sh`. */
const run = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })

/** Same, but a failure is an answer rather than a crash — every source here is
 *  optional, and a missing phone must not stop the check that does not need one. */
function tryRun(command, args, options = {}) {
  try {
    return run(command, args, { stdio: ['ignore', 'pipe', 'ignore'], ...options })
  } catch {
    return null
  }
}

/** As above, but raw bytes: an APK's `AndroidManifest.xml` is binary, and
 *  decoding it as UTF-8 on the way out corrupts exactly the strings wanted. */
function tryRunBytes(command, args) {
  return tryRun(command, args, { encoding: 'buffer' })
}

console.log(`Checking a publish to "${branch}"…\n`)

const localFingerprint = JSON.parse(
  run('npx', ['expo-updates', 'fingerprint:generate', '--platform', 'android']),
).hash

/*
 * The channel an APK listens on.
 *
 * ⚠️ **The strings in a binary `AndroidManifest.xml` are UTF-16LE.** Reading it
 * as UTF-8 finds nothing at all — which does not fail, it just returns `null`,
 * and a null channel silently excludes that build from the comparison. That is
 * the exact shape of the bug this file exists to fix, so both encodings are
 * tried and the answer is whichever one actually contains the header.
 *
 * The channel is not a plain manifest attribute either: expo-updates stores it
 * inside the request-headers JSON, as `{"expo-channel-name":"production"}`.
 */
function channelOf(manifestBytes) {
  if (!manifestBytes) return null
  for (const encoding of ['utf16le', 'latin1']) {
    const match = /"expo-channel-name"\s*:\s*"([^"]+)"/.exec(manifestBytes.toString(encoding))
    if (match) return match[1]
  }
  return null
}

// ---------------------------------------------------------------------------
// 1. The phone, if one is attached.
// ---------------------------------------------------------------------------

/**
 * What the installed APK actually runs.
 *
 * `unzip` runs **on the device** — Android's toybox has it — so nothing is
 * pulled: the base APK is over a hundred megabytes and this needs forty bytes
 * of it. `assets/fingerprint` is the string expo-updates serves against, so
 * this is the same value the update server matches on, not a proxy for it.
 */
function fromDevice() {
  const adb = process.env.ADB ?? 'adb'
  const listed = tryRun(adb, ['devices'])
  if (!listed) return []

  const serials = listed
    .split('\n')
    .slice(1)
    .filter((line) => /\tdevice$/.test(line.trim()) || /\sdevice$/.test(line.trim()))
    .map((line) => line.split(/\s+/)[0])
    .filter(Boolean)

  return serials.flatMap((serial) => {
    const path = tryRun(adb, ['-s', serial, 'shell', 'pm', 'path', PACKAGE])
      ?.split('\n')
      .map((line) => line.trim().replace(/^package:/, ''))
      .find((line) => line.endsWith('.apk'))
    if (!path) return []

    const fingerprint = tryRun(adb, [
      '-s',
      serial,
      'exec-out',
      `unzip -p '${path}' assets/fingerprint`,
    ])?.trim()
    if (!fingerprint) return []

    const manifest = tryRunBytes(adb, [
      '-s',
      serial,
      'exec-out',
      `unzip -p '${path}' AndroidManifest.xml`,
    ])
    return [
      {
        id: serial,
        origin: 'device',
        channel: channelOf(manifest),
        runtimeVersion: fingerprint,
        gitCommitHash: null,
        // A phone outranks everything, so its age never has to break a tie.
        builtAt: Number.MAX_SAFE_INTEGER,
      },
    ]
  })
}

// ---------------------------------------------------------------------------
// 2. APKs `build-local.sh` left in `mobile/`.
// ---------------------------------------------------------------------------

function fromLocalApks() {
  const here = new URL('..', import.meta.url).pathname
  if (!existsSync(here)) return []

  return readdirSync(here)
    .filter((name) => /^build-.*\.apk$/.test(name))
    .flatMap((name) => {
      const path = join(here, name)
      const fingerprint = tryRun('unzip', ['-p', path, 'assets/fingerprint'])?.trim()
      if (!fingerprint) return []
      const manifest = tryRunBytes('unzip', ['-p', path, 'AndroidManifest.xml'])
      return [
        {
          id: name,
          origin: 'local',
          channel: channelOf(manifest),
          runtimeVersion: fingerprint,
          gitCommitHash: null,
          builtAt: statSync(path).mtimeMs,
        },
      ]
    })
}

// ---------------------------------------------------------------------------
// 3. EAS.
// ---------------------------------------------------------------------------

/*
 * Finished builds only. A build that failed, was cancelled, or is still running
 * is not on anybody's phone, and treating one as the installed binary would
 * produce a confident answer about a device that does not exist.
 */
function fromEas() {
  const listed = tryRun('npx', [
    'eas',
    'build:list',
    '--platform',
    'android',
    '--status',
    'finished',
    '--limit',
    '10',
    '--non-interactive',
    '--json',
  ])
  if (!listed) return []
  return JSON.parse(listed).map((build) => ({
    id: build.id,
    origin: 'eas',
    channel: build.channel ?? null,
    runtimeVersion: build.runtimeVersion ?? null,
    gitCommitHash: build.gitCommitHash ?? null,
    builtAt: build.completedAt ? Date.parse(build.completedAt) : null,
  }))
}

const builds = [...fromDevice(), ...fromLocalApks(), ...fromEas()]

const counted = builds.reduce((totals, build) => {
  totals[build.origin] = (totals[build.origin] ?? 0) + 1
  return totals
}, {})
console.log(
  `Found: ${['device', 'local', 'eas'].map((k) => `${counted[k] ?? 0} ${k}`).join(', ')}\n`,
)

const verdict = preflight({ localFingerprint, branch, builds })
console.log(describeVerdict(verdict))
process.exit(blocksPublish(verdict) ? 1 : 0)

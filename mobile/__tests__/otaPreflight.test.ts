/**
 * Whether a publish can reach the phone (#418).
 *
 * The script around this needs EAS and a network; the decision does not, and
 * the decision is the part that was missing on 2026-08-10 — a publish reported
 * `Published!`, named a runtime version, and reached nothing, because nothing
 * compared that version to the one on the installed binary.
 */
import { blocksPublish, describeVerdict, preflight } from '../src/updates/preflight'

type Build = Parameters<typeof preflight>[0]['builds'][number]

const build = (overrides: Partial<Build> = {}): Build => ({
  id: '726b3650-0000-0000-0000-000000000000',
  origin: 'eas',
  channel: 'production',
  runtimeVersion: 'f8570a5dac1507761dfa0e30caa07f76023ae9e7',
  gitCommitHash: 'e29fed50aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  builtAt: Date.parse('2026-08-10T00:00:00Z'),
  ...overrides,
})

describe('preflight', () => {
  it('passes when the tree fingerprints what the installed build runs', () => {
    const verdict = preflight({
      localFingerprint: 'f8570a5dac1507761dfa0e30caa07f76023ae9e7',
      branch: 'production',
      builds: [build()],
    })

    expect(verdict).toMatchObject({ kind: 'will-apply' })
    expect(blocksPublish(verdict)).toBe(false)
  })

  /** The 2026-08-10 failure, exactly: #414 added one line to `app.json`, the
   *  fingerprint moved, and the phone stayed where it was. */
  it('catches a tree whose native side has moved since the build', () => {
    const verdict = preflight({
      localFingerprint: 'df9ade3276b395890c7fc378bc48096b1a7e2dda',
      branch: 'production',
      builds: [build()],
    })

    expect(verdict).toMatchObject({ kind: 'will-not-apply' })
    expect(blocksPublish(verdict)).toBe(true)
  })

  it('says so when nothing is listening on the branch at all', () => {
    const verdict = preflight({
      localFingerprint: 'f8570a5dac1507761dfa0e30caa07f76023ae9e7',
      branch: 'production',
      builds: [build({ channel: 'development' })],
    })

    expect(verdict).toMatchObject({ kind: 'no-build', branch: 'production' })
    expect(blocksPublish(verdict)).toBe(true)
  })

  /**
   * The channel is the coarser mistake and has to be checked first.
   *
   * A development APK can fingerprint identically to a production one — the
   * fingerprint hashes the *native project*, and the build profile is not part
   * of it. So "the fingerprints match" would be true here and completely
   * misleading: nothing published to `production` ever reaches it.
   */
  it('does not pass a matching fingerprint on the wrong channel', () => {
    const verdict = preflight({
      localFingerprint: 'f8570a5dac1507761dfa0e30caa07f76023ae9e7',
      branch: 'production',
      builds: [build({ channel: 'development' })],
    })

    expect(verdict.kind).not.toBe('will-apply')
  })

  it('judges the newest build on the channel, not the newest overall', () => {
    const verdict = preflight({
      localFingerprint: 'newnewnewnewnewnewnewnewnewnewnewnewnew00',
      branch: 'production',
      builds: [
        // Newest, but a different channel — it is not the phone being tested.
        build({
          id: 'aaaaaaaa',
          channel: 'development',
          runtimeVersion: 'something-else',
          builtAt: Date.parse('2026-08-14T00:00:00Z'),
        }),
        build({
          id: 'bbbbbbbb',
          runtimeVersion: 'newnewnewnewnewnewnewnewnewnewnewnewnew00',
          builtAt: Date.parse('2026-08-12T00:00:00Z'),
        }),
      ],
    })

    expect(verdict).toMatchObject({ kind: 'will-apply', build: { id: 'bbbbbbbb' } })
  })

  it('ignores older builds on the channel once the newest is found', () => {
    const verdict = preflight({
      localFingerprint: 'oldoldoldoldoldoldoldoldoldoldoldoldold0',
      branch: 'production',
      builds: [
        build({
          id: 'newest',
          runtimeVersion: 'currentcurrentcurrentcurrentcurrentcurr0',
          builtAt: Date.parse('2026-08-14T00:00:00Z'),
        }),
        // A phone somewhere still runs this, but the question is about the
        // device someone most recently installed on.
        build({
          id: 'older',
          runtimeVersion: 'oldoldoldoldoldoldoldoldoldoldoldoldold0',
          builtAt: Date.parse('2026-08-01T00:00:00Z'),
        }),
      ],
    })

    expect(verdict).toMatchObject({ kind: 'will-not-apply', build: { id: 'newest' } })
  })
})

describe('the message', () => {
  it('names both fingerprints and the commit that was built', () => {
    const message = describeVerdict(
      preflight({
        localFingerprint: 'df9ade3276b395890c7fc378bc48096b1a7e2dda',
        branch: 'production',
        builds: [build()],
      }),
    )

    // The information exists twice already — in the publish output and on the
    // Diagnostics screen. What was missing is one place saying they should be
    // equal and are not, and *which commit* the installed one came from.
    expect(message).toMatch(/f8570a5dac15/)
    expect(message).toMatch(/df9ade3276b3/)
    expect(message).toMatch(/e29fed50/)
    expect(message).toMatch(/NOT reach/)
  })

  it('is quiet and affirmative when there is nothing to warn about', () => {
    const message = describeVerdict(
      preflight({
        localFingerprint: 'f8570a5dac1507761dfa0e30caa07f76023ae9e7',
        branch: 'production',
        builds: [build()],
      }),
    )

    expect(message).toMatch(/will apply/)
    expect(message).not.toMatch(/NOT/)
  })
})

/**
 * Which source gets believed (#536).
 *
 * On 2026-08-14 the EAS free plan ran out, builds moved to
 * `scripts/build-local.sh`, and `eas build:list` — which cannot see a local
 * build — kept naming a cloud build from days earlier. The check reported
 * "this update will NOT reach the installed app" about an update that did
 * reach it, twice, and the working answer became "ignore the tool".
 *
 * A check that is wrong is worse than no check, because the habit it teaches
 * is to override it. So the order is by *how much a source knows*, not by age.
 */
describe('which build is believed', () => {
  const CURRENT = 'ee915ebf1735b410a799cae9b80305f1b562d9a2'
  const STALE = '6f0b0074c0c7aaaaaaaaaaaaaaaaaaaaaaaaaaaa'

  it('believes the phone over a newer cloud build — the whole of #536', () => {
    const verdict = preflight({
      localFingerprint: CURRENT,
      branch: 'production',
      builds: [
        // Exactly the situation on 2026-08-15: EAS's newest is stale, and the
        // phone is running a local build EAS has never heard of.
        build({
          id: '56dd6cbe',
          origin: 'eas',
          runtimeVersion: STALE,
          builtAt: Date.parse('2026-08-14T00:00:00Z'),
        }),
        build({
          id: 'phone-serial',
          origin: 'device',
          runtimeVersion: CURRENT,
          builtAt: Date.parse('2026-08-01T00:00:00Z'),
        }),
      ],
    })

    expect(verdict).toMatchObject({ kind: 'will-apply', build: { origin: 'device' } })
    expect(blocksPublish(verdict)).toBe(false)
  })

  it('believes a local APK over a cloud build, since EAS cannot see one', () => {
    const verdict = preflight({
      localFingerprint: CURRENT,
      branch: 'production',
      builds: [
        build({
          origin: 'eas',
          runtimeVersion: STALE,
          builtAt: Date.parse('2026-08-14T12:00:00Z'),
        }),
        build({
          id: 'build-1786733535212.apk',
          origin: 'local',
          runtimeVersion: CURRENT,
          builtAt: Date.parse('2026-08-14T09:00:00Z'),
        }),
      ],
    })

    expect(verdict).toMatchObject({ kind: 'will-apply', build: { origin: 'local' } })
  })

  it('still blocks when the phone genuinely cannot take the update', () => {
    // The instrument has to be able to produce the other answer, or it has
    // measured nothing — and a device reading is the one most likely to be
    // trusted blindly.
    const verdict = preflight({
      localFingerprint: CURRENT,
      branch: 'production',
      builds: [build({ id: 'phone-serial', origin: 'device', runtimeVersion: STALE })],
    })

    expect(verdict).toMatchObject({ kind: 'will-not-apply', build: { origin: 'device' } })
    expect(blocksPublish(verdict)).toBe(true)
  })

  it('does not believe a phone on another channel', () => {
    // A development build on the bench is still not what `production` reaches.
    const verdict = preflight({
      localFingerprint: CURRENT,
      branch: 'production',
      builds: [
        build({ origin: 'device', channel: 'development', runtimeVersion: CURRENT }),
        build({ origin: 'eas', runtimeVersion: STALE }),
      ],
    })

    expect(verdict).toMatchObject({ kind: 'will-not-apply', build: { origin: 'eas' } })
  })

  it('prefers the newer of two builds from the same source', () => {
    const verdict = preflight({
      localFingerprint: CURRENT,
      branch: 'production',
      builds: [
        build({
          id: 'yesterday.apk',
          origin: 'local',
          runtimeVersion: STALE,
          builtAt: Date.parse('2026-08-14T00:00:00Z'),
        }),
        build({
          id: 'today.apk',
          origin: 'local',
          runtimeVersion: CURRENT,
          builtAt: Date.parse('2026-08-15T00:00:00Z'),
        }),
      ],
    })

    expect(verdict).toMatchObject({ kind: 'will-apply', build: { id: 'today.apk' } })
  })
})

describe('saying how sure it is', () => {
  const CURRENT = 'ee915ebf1735b410a799cae9b80305f1b562d9a2'
  const STALE = '6f0b0074c0c7aaaaaaaaaaaaaaaaaaaaaaaaaaaa'

  it('warns that a non-device answer is inferred', () => {
    const message = describeVerdict(
      preflight({
        localFingerprint: CURRENT,
        branch: 'production',
        builds: [build({ origin: 'eas', runtimeVersion: STALE })],
      }),
    )

    // #536 was a confident answer from the wrong source. An instrument that
    // cannot express its own confidence teaches people to ignore it the first
    // time it is wrong.
    expect(message).toMatch(/inferred, not read off a phone/)
  })

  it('does not hedge when it did read a phone', () => {
    const message = describeVerdict(
      preflight({
        localFingerprint: CURRENT,
        branch: 'production',
        builds: [build({ id: 'phone-serial', origin: 'device', runtimeVersion: STALE })],
      }),
    )

    expect(message).not.toMatch(/inferred/)
    expect(message).toMatch(/the phone \(phone-serial\)/)
  })

  it('names the source on a passing answer too', () => {
    const message = describeVerdict(
      preflight({
        localFingerprint: CURRENT,
        branch: 'production',
        builds: [build({ id: 'build-42.apk', origin: 'local', runtimeVersion: CURRENT })],
      }),
    )

    expect(message).toMatch(/local APK build-42\.apk/)
  })
})

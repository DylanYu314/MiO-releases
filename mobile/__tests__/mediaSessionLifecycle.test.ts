import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The two Kotlin faults that took the media session down (#435).
 *
 * The 2026-08-09 build crashed on a *timer*, on screens with nothing in common,
 * with nothing in Diagnostics — because a native crash never reaches a
 * JavaScript log. `SESSION_ENABLED = false` bought the app back; this is what
 * had to be true before it could go on again.
 *
 * ## Why these read the source
 *
 * Both faults are lifecycle, in Kotlin, in a foreground service. Nothing in
 * jest can start an Android service, and the journey test next door runs
 * against a *mock* of this module — so it would pass just as happily against
 * the version that killed the process every five seconds. The only thing that
 * can fail on the real defect is a reading of the real file.
 *
 * Same shape as `equalizerThreadSafety.test.ts`, which exists because #303 cost
 * five builds on a rule no unit test could see.
 *
 * **Comments are stripped first.** #303 also shipped a source-reading guard
 * that passed against broken code, because the word it looked for survived in
 * the docblock explaining it — and this file's docblocks are full of the exact
 * words being searched for.
 */

const kotlin = (name: string): string =>
  readFileSync(
    join(
      __dirname,
      '..',
      'modules',
      'mio-media-session',
      'android',
      'src',
      'main',
      'java',
      'dev',
      'dylanyu',
      'mio',
      'mediasession',
      name,
    ),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

const moduleSource = kotlin('MioMediaSessionModule.kt')
const serviceSource = kotlin('MioMediaSessionService.kt')

/**
 * Since Android 12, a process that calls `startForegroundService` and does not
 * reach `startForeground` within five seconds is killed with
 * `ForegroundServiceDidNotStartInTimeException`.
 *
 * media3 posts its notification only once the player leaves `STATE_IDLE`, and
 * `JsBackedPlayer` is born idle because nothing is playing when the app opens.
 * So the app lit a fuse it could not put out, on every launch and every remount
 * of `PlayerHost`.
 *
 * It never needed to light one. Read in media3 1.9.0's own sources:
 * `MediaNotificationManager.startForeground` calls
 * `ContextCompat.startForegroundService` itself, at the moment it already holds
 * the notification — so the promotion and the deadline are the same event.
 */
describe('the service is never promoted before it has a notification', () => {
  it('starts the session service without demanding foreground', () => {
    expect(moduleSource).toMatch(/context\.startService\(/)
  })

  it('never calls startForegroundService itself', () => {
    // The single line that crashed the build. Anywhere in this module, at any
    // API level, for any reason.
    expect(moduleSource).not.toMatch(/startForegroundService/)
  })

  it('names a background refusal rather than calling it a failure', () => {
    // A plain `startService` from a backgrounded app is refused with
    // `IllegalStateException`, and `PlayerHost` can remount while the app is
    // away. A device report has to be able to tell that from a real fault.
    expect(moduleSource).toMatch(/IllegalStateException/)
    expect(moduleSource).toMatch(/NOT_ALLOWED_FROM_BACKGROUND/)
  })
})

/**
 * The line whose absence made #397 look impossible (#469).
 *
 * Building a `MediaSession` inside a `MediaSessionService` does **not** connect
 * it to the service's notification machinery. `addSession` does, and it is the
 * only thing that does:
 *
 *     MediaSessionService.addSession                          (line 300)
 *       → getMediaNotificationManager().addSession(session)    (line 315)
 *         → MediaController with KEY_MEDIA_NOTIFICATION_CONTROLLER_FLAG (108)
 *         → listener.onConnected(shouldShowNotification(…))    (line 120)
 *         → the notification is posted
 *
 * Nothing else reached it here: `onStartCommand` returns early for an intent it
 * does not recognise (line 450) and nothing binds this service. So the session
 * was `active=true` on the device with **no notification** — invisible to the
 * notification shade and to the lock screen — and the conclusion drawn from
 * that was that expo-audio's session had won. It had not. Ours was never in the
 * running.
 *
 * The notification is also what makes media3 promote the service to the
 * foreground, which is what keeps playback alive with the screen off.
 */
describe('the session is registered, not merely built (#469)', () => {
  it('adds the session to the service', () => {
    expect(serviceSource).toMatch(/addSession\(built\)/)
  })

  it('adds it after the session exists and before running is announced', () => {
    // Ordering is not decoration: `addSession` takes the built session, and
    // `running` is what a device report reads to mean "there is a session".
    const built = serviceSource.search(/val built = builder\.build\(\)/)
    const added = serviceSource.search(/addSession\(built\)/)
    const running = serviceSource.search(/MioMediaSessionHub\.running = true/)
    expect(built).toBeGreaterThan(-1)
    expect(built).toBeLessThan(added)
    expect(added).toBeLessThan(running)
  })

  it('withdraws it again when the service goes away', () => {
    // The notification manager holds a `MediaController` on this session;
    // releasing without withdrawing leaves that controller pointed at nothing.
    expect(serviceSource).toMatch(/removeSession\(it\)/)
  })
})

/**
 * The second defect, and the quieter one.
 *
 * `update()` returned false and **threw the state away** whenever the player was
 * null — which it is until the service reaches `onCreate`. `start()` is
 * asynchronous, so the first real track's metadata could land in that window and
 * vanish. The session then came up idle, which is also the state media3 declines
 * to post any notification for, so the lock screen stayed blank until the *next*
 * track.
 */
describe('state that arrives before the service does', () => {
  it('is kept rather than dropped', () => {
    expect(moduleSource).toMatch(/MioMediaSessionHub\.pending = state/)
    // Stored *before* the null check, or it is dropped exactly as before.
    const stored = moduleSource.search(/MioMediaSessionHub\.pending = state/)
    const nullCheck = moduleSource.search(/MioMediaSessionHub\.player \?: return@Function false/)
    expect(stored).toBeGreaterThan(-1)
    expect(nullCheck).toBeGreaterThan(-1)
    expect(stored).toBeLessThan(nullCheck)
  })

  it('is applied when the service comes up', () => {
    expect(serviceSource).toMatch(
      /MioMediaSessionHub\.pending\?\.let\s*\{\s*player\.show\(it\)\s*\}/,
    )
  })

  it('is applied before the session is built, so it is never born idle', () => {
    // media3 posts no notification for an idle player, so a session built ahead
    // of its first state is a lock screen with nothing on it.
    const applied = serviceSource.search(/MioMediaSessionHub\.pending\?\.let/)
    const built = serviceSource.search(/MediaSession\.Builder\(/)
    expect(applied).toBeGreaterThan(-1)
    expect(built).toBeGreaterThan(-1)
    expect(applied).toBeLessThan(built)
  })
})

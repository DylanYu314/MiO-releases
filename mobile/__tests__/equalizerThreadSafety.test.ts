import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The equaliser must touch the player on the main thread (#303, fifth attempt).
 *
 * ## Why a test that reads source
 *
 * The Kotlin cannot run here — no jest, no ExoPlayer, no phone — and this bug
 * survived **five builds** precisely because nothing between "write it" and
 * "hold a phone twenty minutes later" could see it. The property is structural
 * and therefore readable, so it is read. `pressFeedbackConsistency.test.ts` is
 * the same trick for the same reason.
 *
 * ## The property
 *
 * `expo-audio` builds its player with `.setLooper(context.mainLooper)`
 * (`AudioPlayer.kt`), and every ExoPlayer method starts with
 * `verifyApplicationThread()`, which throws `IllegalStateException` off that
 * thread. An Expo `Function` runs on the JS thread. So **every** reflective call
 * into the player has to be inside a main-thread hop, and one that is not is not
 * a style problem — it is the entire bug, again.
 *
 * Four fixes were written for this file without anyone suspecting the thread,
 * because "the method cannot be reached" and "the call is refused" produce the
 * same silence. The device finally said `session_blocked:IllegalStateException`
 * and that one word was the whole answer.
 */
const SOURCE = join(
  __dirname,
  '../modules/mio-equalizer/android/src/main/java/dev/dylanyu/mio/equalizer/MioEqualizerModule.kt',
)

const source = readFileSync(SOURCE, 'utf8')
const lines = source.split('\n')

/** Lines that call into the player reflectively, comments excluded — a docblock
 *  discussing `invoke` is prose, not a call. */
const invocations = lines.filter((line) => {
  const code = line.trim()
  if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return false
  return code.includes('.invoke(')
})

describe('the equaliser module', () => {
  it('has a main-thread hop at all', () => {
    // `runBlocking(appContext.mainQueue.coroutineContext)` is expo-audio's own
    // idiom for exactly this (`AudioModule.kt`), and the library that owns the
    // player is the right authority on how to touch it.
    expect(source).toMatch(/runBlocking\(appContext\.mainQueue\.coroutineContext\)/)
  })

  it('reaches the player only from the main thread', () => {
    // A guard that matched nothing would pass forever. This is the mutation the
    // suite cannot otherwise see: rename the call and the check evaporates.
    expect(invocations.length).toBeGreaterThan(0)

    for (const line of invocations) {
      expect(line).toMatch(/runOnMain/)
    }
  })

  it('does not pay for the hop on every call', () => {
    /*
     * `runOnMain` blocks the JS thread, and `setGains` runs on every frame of a
     * drag, for both decks. Without a cache this fix would land #372's bug in
     * place of #303's — which is the shape of trade this project has made
     * before and had to undo.
     */
    expect(source).toMatch(/sessionIds\[ref\]\?\.let \{ return SessionLookup\.Found\(it\) \}/)
    /*
     * Identity, not equality: two decks that compared equal would share one
     * session and equalise the wrong audio mid-crossfade.
     *
     * Asserted on the **declaration**, not on the file. The first version of
     * this matched anywhere in the source and passed against a plain
     * `mutableMapOf`, because the word survived in the docblock above it — a
     * test that reads source has to be told the difference between code and
     * prose about code, or it grades the comments.
     */
    const declaration = lines.find((line) => line.includes('val sessionIds'))
    expect(declaration).toMatch(/IdentityHashMap/)
  })

  it('never caches the one answer that changes on its own', () => {
    // Session id 0 means the renderer has not been given one yet. Caching it
    // would make a transient state permanent and silently delete the retry
    // #303 added.
    expect(source).toMatch(/id == 0 -> SessionLookup\.Found\(0\)/)
  })
})

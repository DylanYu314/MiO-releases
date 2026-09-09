import { resetDeviceAdds, useDeviceAdds } from '../src/api/deviceAdds'
import { isFetching } from '../src/api/fetching'
import { resetTrackStates, useTrackStates } from '../src/api/trackStates'

/**
 * Who is fetching what, app-wide (#571).
 *
 * The library screen used to keep this in its own `useState`, set only when the
 * user tapped a row **on that screen**. A track being fetched by a playlist
 * import, an add-link or a search result read as "Not downloaded — tap to
 * download", and tapping it started a second concurrent download of the same
 * track — two writers appending 2 MiB chunks to one file path.
 *
 * These are the cases that were wrong, not a re-test of the stores.
 */

const URL = 'https://youtu.be/dQw4w9WgXcQ'

const adds = () => useDeviceAdds.getState().adds
const runs = () => useTrackStates.getState().runs

beforeEach(() => {
  resetDeviceAdds()
  resetTrackStates()
})

describe('isFetching', () => {
  it('is false when nothing is happening', () => {
    expect(isFetching(URL, adds(), runs())).toBe(false)
  })

  it('sees an add-link, a search result or a library tap', () => {
    // All three go through `importToDevice`, which records the add itself —
    // which is why the screen no longer sets or clears anything by hand.
    useDeviceAdds.getState().started(URL, 'link')

    expect(isFetching(URL, adds(), runs())).toBe(true)
  })

  it('sees a review-based playlist import, which writes the other store', () => {
    /*
     * ⚠️ The case that makes this two stores instead of one.
     * `playlistImport.ts` runs its own loop and never touches `useDeviceAdds`
     * — the same split that shipped #555. Reading only the adds would leave
     * every track of a Spotify, NetEase, QQ or Kugou import tappable while it
     * downloaded.
     */
    useTrackStates.getState().set('7', URL, { phase: 'downloading', attempt: 1, failure: null })

    expect(isFetching(URL, adds(), runs())).toBe(true)
  })

  it.each(['waiting', 'extracting', 'downloading', 'saving'] as const)(
    'counts %s as in flight',
    (phase) => {
      // `waiting` included deliberately: the track is claimed by a run that will
      // reach it, and starting a second fetch for it is the same collision.
      useTrackStates.getState().set('7', URL, { phase, attempt: 1, failure: null })

      expect(isFetching(URL, adds(), runs())).toBe(true)
    },
  )

  it.each(['done', 'failed', 'carried'] as const)('does not count %s', (phase) => {
    // The other half, and the half that keeps the feature working: a track that
    // *failed* must stay tappable, because tapping it is the only way to
    // recover a track a playlist import could not get (#268).
    useTrackStates.getState().set('7', URL, { phase, attempt: 1, failure: null })

    expect(isFetching(URL, adds(), runs())).toBe(false)
  })

  it('does not count a finished or failed add', () => {
    useDeviceAdds.getState().started(URL, 'link')
    useDeviceAdds.getState().failed(URL, 'refused', 'refused')

    expect(isFetching(URL, adds(), runs())).toBe(false)
  })

  it('answers about the URL asked for, not any URL', () => {
    // The mutation this kills is a `some()` that forgot its predicate.
    useDeviceAdds.getState().started('https://youtu.be/other11chr', 'link')

    expect(isFetching(URL, adds(), runs())).toBe(false)
  })

  it('finds a track claimed by any run, not only the first', () => {
    // `runs` is keyed by import id and several can be recorded at once. Reading
    // one of them would leave the rest of the app's tracks tappable.
    useTrackStates
      .getState()
      .set('1', 'https://youtu.be/aaaaaaaaaaa', { phase: 'done', attempt: 1, failure: null })
    useTrackStates.getState().set('2', URL, { phase: 'downloading', attempt: 1, failure: null })

    expect(isFetching(URL, adds(), runs())).toBe(true)
  })
})

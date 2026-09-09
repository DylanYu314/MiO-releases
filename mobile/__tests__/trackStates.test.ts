import {
  failuresIn,
  resetTrackStates,
  useTrackStates,
  type TrackState,
} from '../src/api/trackStates'
import { rowStateFor } from '../src/components/MatchReview'

/**
 * Where every track of an import has got to (#452).
 *
 * The bar says "45 of 135" and names the one track in hand. With
 * `CONCURRENCY = 2`, most of a 135-track import is neither in hand nor
 * finished, and the interesting question — *which* tracks failed and why — has
 * until now only been answerable by reading Diagnostics.
 */

const state = (over: Partial<TrackState> = {}): TrackState => ({
  phase: 'waiting',
  attempt: 1,
  failure: null,
  ...over,
})

beforeEach(resetTrackStates)

describe('holding the state of every track', () => {
  it('keeps runs apart, because several can be in flight', () => {
    useTrackStates.getState().set('5', 'https://youtu.be/a', state({ phase: 'downloading' }))
    useTrackStates.getState().set('6', 'https://youtu.be/a', state({ phase: 'failed' }))

    expect(useTrackStates.getState().forImport('5')['https://youtu.be/a'].phase).toBe('downloading')
    expect(useTrackStates.getState().forImport('6')['https://youtu.be/a'].phase).toBe('failed')
  })

  it('answers with an empty map for a run it has never seen', () => {
    // A screen can mount before any run has started, and `undefined` here would
    // be a crash on the first row.
    expect(useTrackStates.getState().forImport('99')).toEqual({})
  })

  it('clears a run when it starts again', () => {
    useTrackStates.getState().set('5', 'https://youtu.be/a', state({ phase: 'failed' }))
    useTrackStates.getState().reset('5')

    // A retry that fetches the four tracks that failed last time is the truth
    // about this import now; leaving the old states would show both answers.
    expect(useTrackStates.getState().forImport('5')).toEqual({})
  })
})

describe('what gets written down for next time', () => {
  it('keeps the failures and nothing else', () => {
    const states = {
      'https://youtu.be/a': state({ phase: 'done' }),
      'https://youtu.be/b': state({ phase: 'failed', failure: 'timed_out' }),
      'https://youtu.be/c': state({ phase: 'carried' }),
    }

    // Only the failures: a `done` track is already answered by the library
    // holding its audio, and writing 135 entries to record that 131 worked is a
    // cost with no reader.
    expect(failuresIn(states)).toEqual({ 'https://youtu.be/b': 'timed_out' })
  })

  it('does not record a failure it could not name', () => {
    const states = { 'https://youtu.be/b': state({ phase: 'failed', failure: null }) }

    expect(failuresIn(states)).toEqual({})
  })
})

/**
 * Which answer a row should show, when there are two sources for it.
 *
 * The live store knows what is happening *now*; the persisted record knows what
 * happened last time. During a run the first is right, after a restart only the
 * second exists, and getting the precedence wrong shows a stale failure over a
 * download that is currently working.
 */
describe('deciding what a row says', () => {
  it('prefers the live state over what was remembered', () => {
    const live = { 'https://youtu.be/a': state({ phase: 'downloading' }) }
    const remembered = { 'https://youtu.be/a': 'timed_out' as const }

    // Mid-retry, the record still describes the run that failed. Showing it
    // would tell the user a download in progress had already failed.
    expect(rowStateFor('https://youtu.be/a', live, remembered, false)).toEqual({
      phase: 'downloading',
      failure: null,
    })
  })

  it('falls back to the remembered failure after a restart', () => {
    // The store dies with the JS context, and "which four failed and why" is
    // exactly what somebody asks on coming back to the app.
    expect(
      rowStateFor('https://youtu.be/a', {}, { 'https://youtu.be/a': 'refused' }, false),
    ).toEqual({ phase: 'failed', failure: 'refused' })
  })

  it('says nothing about a track that is simply on the device', () => {
    // The list already means that; a second label would be noise on every row
    // of a successful import.
    expect(rowStateFor('https://youtu.be/a', {}, undefined, true)).toBeNull()
  })

  it('still calls a missing track failed when no reason was kept', () => {
    // Imports that finished before #452 have no reasons. A failed row with no
    // explanation is still a failed row, which is where the screen already was.
    expect(rowStateFor('https://youtu.be/a', {}, undefined, false)).toEqual({
      phase: 'failed',
      failure: null,
    })
  })

  it('has nothing to say about a track with no chosen URL', () => {
    expect(rowStateFor(null, {}, undefined, false)).toBeNull()
  })
})

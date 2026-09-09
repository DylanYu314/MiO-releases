import AsyncStorage from '@react-native-async-storage/async-storage'

import { inFlight, useActiveImports } from '../src/api/activeImports'

/**
 * #182: an import used to be forgotten the moment its screen unmounted.
 *
 * The job never stopped — `ImportJob` is a row and the socket reconnects from
 * the id — so what was lost was only the client's knowledge of *which* job to
 * watch. These pin that the knowledge now outlives the screen.
 */
beforeEach(async () => {
  useActiveImports.setState({ imports: [] })
  await AsyncStorage.clear()
})

describe('tracked imports (#182)', () => {
  it('keeps a started import, newest first', () => {
    useActiveImports.getState().track(1, 'https://youtube.com/watch?v=a')
    useActiveImports.getState().track(2, 'https://youtube.com/watch?v=b')

    expect(useActiveImports.getState().imports.map((entry) => entry.jobId)).toEqual([2, 1])
  })

  it('never tracks the same job twice', () => {
    // Re-entering the add screen must not duplicate what is already there,
    // which is half of what "don't start a new one every time" means.
    useActiveImports.getState().track(1, 'https://youtube.com/watch?v=a')
    useActiveImports.getState().track(1, 'https://youtube.com/watch?v=a')

    expect(useActiveImports.getState().imports).toHaveLength(1)
  })

  it('returns the identical array when a status has not changed', () => {
    // Called from a render-driven effect on every status tick. A fresh array
    // each time would re-render every subscriber twice a second, for nothing.
    useActiveImports.getState().track(1, 'url')
    useActiveImports.getState().setStatus(1, 'downloading')
    const first = useActiveImports.getState().imports

    useActiveImports.getState().setStatus(1, 'downloading')

    expect(useActiveImports.getState().imports).toBe(first)
  })

  it('counts a done job whose audio has not arrived as still in flight', () => {
    /*
     * The rule changed with #159 and this test changed with it.
     *
     * `done` means the *server* finished. Under local-first that is not the end
     * of the import: until the audio is on this device the song is not in the
     * library, and showing "added" over something that cannot be played offline
     * would be a lie.
     */
    useActiveImports.getState().track(1, 'a')
    useActiveImports.getState().track(2, 'b')
    useActiveImports.getState().track(3, 'c')
    useActiveImports.getState().setStatus(1, 'done')
    useActiveImports.getState().setStatus(2, 'failed')
    useActiveImports.getState().setStatus(3, 'downloading')

    // 3 is still downloading on the server; 1 is done there but not here yet.
    // 2 failed, and a failed job has nothing to download.
    expect(
      inFlight(useActiveImports.getState().imports)
        .map((e) => e.jobId)
        .sort(),
    ).toEqual([1, 3])
  })

  it('stops counting it once the audio is on the device', () => {
    useActiveImports.getState().track(1, 'a')
    useActiveImports.getState().setStatus(1, 'done')
    useActiveImports.getState().markSavedLocally(1)

    expect(inFlight(useActiveImports.getState().imports)).toEqual([])
  })

  it('marks a save once, so a relaunch does not download it again', () => {
    // The flag is persisted, which is what makes it safe to use as the guard.
    useActiveImports.getState().track(1, 'a')
    useActiveImports.getState().setStatus(1, 'done')
    useActiveImports.getState().markSavedLocally(1)
    const first = useActiveImports.getState().imports

    useActiveImports.getState().markSavedLocally(1)

    expect(useActiveImports.getState().imports).toBe(first)
  })

  it('a never-updated import counts as in flight', () => {
    // `null` status means the first message has not arrived, not that nothing
    // is happening.
    useActiveImports.getState().track(9, 'z')

    expect(inFlight(useActiveImports.getState().imports).map((e) => e.jobId)).toEqual([9])
  })

  it('clears finished imports without touching running ones', () => {
    useActiveImports.getState().track(1, 'a')
    useActiveImports.getState().track(2, 'b')
    useActiveImports.getState().setStatus(1, 'done')

    useActiveImports.getState().clearFinished()

    expect(useActiveImports.getState().imports.map((e) => e.jobId)).toEqual([2])
  })

  it('survives closing the app, because the download does', async () => {
    useActiveImports.getState().track(42, 'https://youtube.com/watch?v=x')
    useActiveImports.getState().setStatus(42, 'downloading')
    await useActiveImports.persist.rehydrate()

    const raw = await AsyncStorage.getItem('mio-active-imports')
    const persisted = JSON.parse(raw ?? '{}').state

    expect(persisted.imports[0]).toMatchObject({ jobId: 42, status: 'downloading' })
  })

  it('keeps the list to a recent-activity length', () => {
    for (let id = 1; id <= 25; id++) useActiveImports.getState().track(id, `url-${id}`)

    // A capped list, not history. `GET /jobs` is the real record if one is
    // ever wanted.
    expect(useActiveImports.getState().imports).toHaveLength(20)
    expect(useActiveImports.getState().imports[0].jobId).toBe(25)
  })
})

import AsyncStorage from '@react-native-async-storage/async-storage'

import { searchOnDevice } from '../src/library/deviceSearch'
import { currentSearchSource, loadSearchSource, useSearchSource } from '../src/library/searchSource'

/**
 * The candidate-source toggle (#551).
 *
 * What this file is really guarding is that the choice reaches **both** ends:
 * the search that is performed, and the `source` posted with each candidate so
 * `matching.py` can withhold the YouTube-only Topic bonus (ADR-013 decision 4).
 * A toggle that changed only the first would silently over-score every Bilibili
 * match, and nothing on screen would say so.
 */

const mockSearchBilibili = jest.fn()
jest.mock('../src/library/bilibiliSearch', () => ({
  searchBilibiliOnDevice: (...args: unknown[]) => mockSearchBilibili(...args),
}))

const mockYoutubeSearch = jest.fn()
jest.mock('../src/library/extract', () => ({
  youtubeClient: async () => ({ search: (...args: unknown[]) => mockYoutubeSearch(...args) }),
}))

beforeEach(async () => {
  jest.clearAllMocks()
  await AsyncStorage.clear()
  useSearchSource.setState({ source: 'youtube' })
  mockYoutubeSearch.mockResolvedValue({ videos: [] })
  mockSearchBilibili.mockResolvedValue([])
})

describe('useSearchSource', () => {
  it('defaults to YouTube', () => {
    // Read from the store's *initial* state, not from `currentSearchSource()`:
    // `beforeEach` above sets the source to youtube, so going through the live
    // value would assert the test's own setup and pass no matter what the store
    // declares. A mutation flipping the real default survived until this was
    // written this way — the same trap as the server's `SearchResult.source`.
    //
    // The same default `SearchResultIn.source` takes, for the same reason:
    // everything predating #551 was a YouTube candidate.
    expect(useSearchSource.getInitialState().source).toBe('youtube')
  })

  it('remembers a choice across launches', async () => {
    await useSearchSource.getState().setSource('bilibili')

    // A fresh process starts at the default and is corrected by the loader.
    useSearchSource.setState({ source: 'youtube' })
    await loadSearchSource()

    expect(currentSearchSource()).toBe('bilibili')
  })

  it('ignores a stored value it does not recognise', async () => {
    await AsyncStorage.setItem('mio-search-source', 'soundcloud')
    await loadSearchSource()

    expect(currentSearchSource()).toBe('youtube')
  })
})

describe('searchOnDevice', () => {
  it('searches YouTube by default', async () => {
    await searchOnDevice('rick astley')

    expect(mockYoutubeSearch).toHaveBeenCalledTimes(1)
    expect(mockSearchBilibili).not.toHaveBeenCalled()
  })

  it('searches Bilibili once the source is switched', async () => {
    await useSearchSource.getState().setSource('bilibili')

    await searchOnDevice('rick astley')

    expect(mockSearchBilibili).toHaveBeenCalledWith('rick astley', 20)
    expect(mockYoutubeSearch).not.toHaveBeenCalled()
  })

  it('takes an explicit source, so one run cannot change platform mid-way', async () => {
    // `deviceMatching` reads the source once and passes it down for the whole
    // run. Without this parameter a user flipping the toggle during a
    // hundred-track import would produce a batch whose candidates disagree
    // about where they came from.
    await searchOnDevice('x', 5, 'bilibili')

    expect(mockSearchBilibili).toHaveBeenCalledWith('x', 5)
    expect(mockYoutubeSearch).not.toHaveBeenCalled()
  })

  it('asks neither source for an empty query', async () => {
    expect(await searchOnDevice('   ')).toEqual([])
    expect(mockSearchBilibili).not.toHaveBeenCalled()
    expect(mockYoutubeSearch).not.toHaveBeenCalled()
  })
})

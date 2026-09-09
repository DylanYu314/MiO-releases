import { useQuery } from '@tanstack/react-query'
import { create } from 'zustand'

import { searchOnDevice } from '../library/deviceSearch'
import { currentSearchSource, type SearchSource } from '../library/searchSource'
import { apiFetch } from './client'
import type { SearchPlatform, SearchResult } from './types'

/**
 * What the search screen is currently showing (#182).
 *
 * The screen kept these in `useState`, under a comment saying TanStack's cache
 * makes returning to a search free. The cache does — but the *query string* went
 * with the component, so nothing ever asked the cache for it. Leaving the screen
 * and coming back gave an empty box and no results, with the answer still sitting
 * in memory a key away.
 *
 * Not persisted, on purpose: a search is a thing you are doing now. Restoring
 * last week's query on a cold start would be clutter, and the cached results
 * behind it would be gone anyway.
 *
 * ## Both halves of the key are snapshotted, or neither is (#240)
 *
 * `query` was taken on submit and `platform` was read live, so the two halves of
 * the query key disagreed about when they were decided: **tapping a platform
 * chip changed the key and fired a search nobody asked for**, against whatever
 * term was last submitted. The fix is `searchedPlatform` — the platform as it
 * was when the button was pressed. Nothing outside `submit` can move the key.
 *
 * Worth keeping even though the chips are hidden while YouTube is the only
 * source (#240 part 2): removing the chip removes the symptom, and this removes
 * the cause. Adding a second source back should not reintroduce the bug.
 *
 * ## ⚠️ And there was a *third* half nobody snapshotted (#632)
 *
 * `SearchSourcePicker` writes `useSearchSource`, which is the control a user
 * actually taps, and `searchOnDevice` read it out of module state from *inside*
 * the `queryFn`. So it was invisible to TanStack: switching YouTube → Bilibili
 * left the key untouched, the screen kept showing YouTube's results, and
 * pressing Search re-submitted the same string — an identical key, served from
 * cache. The button did nothing, which is exactly how I reported it.
 *
 * `searchedSource` is the same answer `searchedPlatform` is, applied to the
 * control that survived #240. The rule this file already stated turned out to
 * have one more half than it knew about.
 */
interface SearchUiState {
  /** What is typed, which is not yet what was searched for. */
  input: string
  /** What was actually submitted — the query key. */
  query: string
  /** The platform chosen in the UI, which is not yet what was searched. */
  platform: SearchPlatform
  /** The platform as it was on submit — the other half of the query key. */
  searchedPlatform: SearchPlatform
  /**
   * The source as it was on submit — the third half (#632).
   *
   * Not settable here: the picker owns the live value (`useSearchSource`,
   * persisted), and this is only ever a snapshot of it. Two writers for one
   * choice is how the live value and the searched one would drift.
   */
  searchedSource: SearchSource
  setInput: (input: string) => void
  submit: () => void
  setPlatform: (platform: SearchPlatform) => void
  /** Past queries, newest first — what #319 asked for instead of a box that
   *  remembers. */
  history: string[]
  clear: () => void
}

/** How many past searches are offered. Enough to find yesterday's, few enough
 *  to be a list rather than a screen. */
const MAX_HISTORY = 10

export const useSearchUi = create<SearchUiState>((set) => ({
  input: '',
  query: '',
  platform: 'youtube',
  searchedPlatform: 'youtube',
  searchedSource: 'youtube',
  history: [],
  setInput: (input) => set({ input }),
  submit: () =>
    set((state) => {
      const query = state.input.trim()
      if (!query) return state
      return {
        query,
        searchedPlatform: state.platform,
        // Read here rather than subscribed to, for the same reason the platform
        // is: nothing outside `submit` may move the query key (#632).
        searchedSource: currentSearchSource(),
        // Remembered here rather than in the screen, so a search run from the
        // history list is recorded the same way as one that was typed.
        history: [query, ...state.history.filter((past) => past !== query)].slice(0, MAX_HISTORY),
      }
    }),
  setPlatform: (platform) => set({ platform }),

  /**
   * Forget the box and the results, keeping the history (#319).
   *
   * *"when there is something in the search box and I switch to
   * Bilibili, or if I re-enter the page, it automatically starts searching — it
   * should have emptied the search box."*
   *
   * The store is module-level and nothing ever cleared it, so returning to the
   * screen re-rendered with the same `query` and TanStack served the cached
   * result — which reads as the app searching on its own. That was #182's
   * deliberate choice (the box used to empty and lose the results); the
   * requirement has since reversed, and the history is what keeps the old one's
   * value without the surprise.
   *
   * The platform is deliberately **not** reset: which source you are searching
   * is a preference, not part of a query.
   */
  clear: () => set({ input: '', query: '' }),
}))

export const searchKeys = {
  query: (platform: SearchPlatform, source: SearchSource, q: string) =>
    ['search', platform, source, q] as const,
}

/**
 * Search a source for something to import.
 *
 * Enabled only for a non-empty query, so it fires on submit rather than on
 * every keystroke — each search reaches the upstream extractor and is slow
 * enough that per-keystroke requests would be both useless and rude.
 *
 * ## YouTube is searched on the device now (#353)
 *
 * It used to be `GET /search`, and on the droplet that endpoint mostly fails:
 * YouTube refuses a datacenter address on every client, measured at 1 request
 * in 14 (#177). A phone is on a residential connection and is not refused,
 * which is the same argument that moved the downloads in #246.
 *
 * The hook's shape is deliberately unchanged, so the screen did not have to be
 * touched — this is a different `queryFn` behind the same key.
 *
 * **Bilibili still goes to the server.** It has no Innertube equivalent, and
 * the whole reason it has its own page (#320) is that the server is the only
 * thing that can fetch it. The branch is kept even though the mobile search
 * screen currently offers YouTube only, because deleting it would make adding a
 * second source later look like a free change when it is not.
 *
 * ⚠️ **`source` is passed rather than read** (#632). `searchOnDevice` defaults
 * it from module state, which is right for its other callers and was wrong
 * here: a value the `queryFn` reads behind TanStack's back is not part of the
 * key, so changing it changed nothing and the cache answered the old question.
 */
export function useSearch(platform: SearchPlatform, source: SearchSource, q: string) {
  return useQuery({
    queryKey: searchKeys.query(platform, source, q),
    queryFn: () =>
      platform === 'youtube'
        ? searchOnDevice(q, undefined, source)
        : apiFetch<SearchResult[]>(
            `/search?q=${encodeURIComponent(q)}&platform=${encodeURIComponent(platform)}`,
          ),
    enabled: q.length > 0,
    // Results don't go stale within a session and the query is expensive, so
    // going back to a previous search shouldn't re-run it.
    staleTime: 5 * 60 * 1000,
  })
}

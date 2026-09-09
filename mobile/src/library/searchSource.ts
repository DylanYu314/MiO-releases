import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'

/**
 * Which platform this device searches for music (#551).
 *
 * ## Why it is a choice and not a detection
 *
 * A user in mainland China cannot reach YouTube, so every path that *finds*
 * music is closed to them — the Search tab, a Spotify import, and the
 * NetEase/QQ/Kugou imports, which hand back titles that still have to be found
 * somewhere. Bilibili is the only source inside China that MiO will take audio
 * from: the project's ground rules and ADR-013 decision 1 restrict it to user-upload video
 * platforms and never to licensed music services.
 *
 * **my call, 2026-08-16: a manual toggle, YouTube by default, applied
 * everywhere that searches.** Not derived from the app language, and not
 * probed by trying YouTube first:
 *
 * - the app's language is not where the user is, and a Chinese-speaking user
 *   outside China would get the worse source for no reason;
 * - trying YouTube and falling back doubles the searches per track, which is
 *   what #100 originally proposed and what `docs/bilibili.md` §2.2 says would
 *   reach Bilibili's rate ceiling twice as fast;
 * - and a user behind the Great Firewall knows they are, whereas neither of
 *   the above can find it out reliably.
 *
 * ## The audio follows the source by construction
 *
 * Nothing here routes downloads. A candidate's URL decides that:
 * `platformOf()` reads it and `importToDevice` picks the extractor (#492), so
 * choosing Bilibili as a search source means Bilibili URLs, which means the
 * Bilibili extractor — with no second decision to keep in step.
 */

export type SearchSource = 'youtube' | 'bilibili'

const SOURCE_KEY = 'mio-search-source'

interface SearchSourceState {
  source: SearchSource
  setSource: (source: SearchSource) => Promise<void>
}

export const useSearchSource = create<SearchSourceState>((set) => ({
  // YouTube, because it is the right answer for most users and because every
  // candidate stored before this was a YouTube one — see `SearchResultIn.source`
  // on the server, which defaults the same way for the same reason.
  source: 'youtube',

  // Set first, then persist, so the toggle moves under the thumb that pressed
  // it rather than after a round trip to disk — the theme store's pattern.
  setSource: async (source) => {
    set({ source })
    await AsyncStorage.setItem(SOURCE_KEY, source)
  },
}))

function isSource(value: string | null): value is SearchSource {
  return value === 'youtube' || value === 'bilibili'
}

/**
 * Apply the stored source, if there is one.
 *
 * Called from the root layout beside the other stored-state loaders, and
 * deliberately not awaited: a search cannot happen before the first paint, so
 * there is nothing to race.
 */
export async function loadSearchSource(): Promise<void> {
  const stored = await AsyncStorage.getItem(SOURCE_KEY)
  if (isSource(stored)) useSearchSource.setState({ source: stored })
}

/** The source without subscribing — for the non-React callers (`deviceMatching`,
 *  `deviceSearch`) that need it once per call rather than on every render. */
export function currentSearchSource(): SearchSource {
  return useSearchSource.getState().source
}

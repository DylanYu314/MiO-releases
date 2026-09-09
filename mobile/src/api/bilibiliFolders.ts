import { useQuery } from '@tanstack/react-query'

import { fetchFavFolders, type FavFolder } from '../library/bilibiliFav'

/**
 * The signed-in user's Bilibili favourites folders (#492, slice 3).
 *
 * A query hook rather than a `useEffect` that sets state, because that is what
 * ADR-003 says server data does here — and because the effect version tripped
 * `react-hooks/set-state-in-effect`, which was right: loading, error and
 * refetch are three states that a hand-rolled effect gets to reinvent badly.
 *
 * Bilibili is not *our* server, but it is server data by every property that
 * matters: it is remote, it can fail, and it should not be refetched on every
 * render.
 *
 * ⚠️ **Not retried.** The two failures this can have are a dead session and a
 * refused request, and neither is fixed by asking again immediately — a dead
 * `SESSDATA` stays dead until the user signs in, and hammering a refusal is how
 * §2.1's fifteen-minute ceiling gets hit. The screen offers the retry, so a
 * person decides.
 */
export const bilibiliFolderKeys = {
  all: ['bilibili', 'folders'] as const,
  forUser: (userId: string) => ['bilibili', 'folders', userId] as const,
}

export function useBilibiliFolders(userId: string | null) {
  return useQuery<FavFolder[]>({
    queryKey: bilibiliFolderKeys.forUser(userId ?? 'none'),
    queryFn: () => fetchFavFolders(userId as string),
    // Nothing to ask for until the login has happened.
    enabled: userId !== null,
    retry: false,
    staleTime: 60_000,
  })
}

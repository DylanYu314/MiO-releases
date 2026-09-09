import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type { ReactNode } from 'react'
import { Alert, FlatList } from 'react-native'
import { GestureHandlerRootView, State } from 'react-native-gesture-handler'
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils'

import PlaylistDetailScreen from '../app/(tabs)/playlists/[id]'
import PlaylistsScreen from '../app/(tabs)/playlists/index'
import { useConnection } from '../src/api/connection'
import { MIGRATIONS } from '../src/library/db'
import { usePlayer } from '../src/player/store'
import '../src/i18n'

/**
 * Playlists, on the device (#219).
 *
 * ## Driven by real SQLite rather than a fake backend
 *
 * This suite used to answer routes with canned JSON. There is no backend in
 * this path any more, and a hand-written fake of the *library* would be worse
 * than the fetch fake was: what these screens depend on is dense positions and
 * a two-pass reorder, so a fake would encode my reading of the SQL rather than
 * the database's.
 *
 * `node:sqlite` is the same engine the phone runs, so the real `playlists.ts`
 * runs unchanged against a real database. Only `openLibraryDb` is swapped, for
 * a thin async adapter.
 */

// `mock`-prefixed so the hoisted `jest.mock` factories may reference it: the
// factory is lifted above every declaration and jest exempts only names
// starting with "mock" from its out-of-scope guard (a convention in this repo).
let mockDb: DatabaseSync

jest.mock('../src/library/db', () => {
  const actual = jest.requireActual('../src/library/db')
  return {
    ...actual,
    openLibraryDb: async () => ({
      runAsync: async (sql: string, params: SQLInputValue[] = []) =>
        mockDb.prepare(sql).run(...params),
      getAllAsync: async (sql: string, params: SQLInputValue[] = []) =>
        mockDb.prepare(sql).all(...params),
      getFirstAsync: async (sql: string, params: SQLInputValue[] = []) =>
        mockDb.prepare(sql).get(...params) ?? null,
      withTransactionAsync: async (task: () => Promise<void>) => {
        mockDb.exec('BEGIN')
        try {
          await task()
          mockDb.exec('COMMIT')
        } catch (error) {
          mockDb.exec('ROLLBACK')
          throw error
        }
      },
    }),
  }
})

// The audio half is native and is not what this suite is about.
jest.mock('expo-file-system', () => ({
  File: class {
    uri = 'file:///library/x.opus'
    exists = false
    delete() {}
  },
  Directory: class {
    exists = true
    create() {}
    list() {
      return []
    }
  },
  Paths: { document: { uri: 'file:///data' } },
}))

/** `scrollToIndex` is a method on the FlatList instance the screen holds a ref
 *  to, so the prototype is the seam — there is no rendered element to assert on
 *  and jsdom has no scrolling. */
const mockScrollToIndex = jest.fn()

const mockPush = jest.fn()
const mockBack = jest.fn()
const mockRoute = { id: 'p1' }
jest.mock('expo-router', () => ({
  // The guard reads the current path to know a navigation landed (#375).
  usePathname: () => '/',
  ...jest.requireActual('expo-router'),
  useLocalSearchParams: () => ({ id: mockRoute.id }),
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: mockBack }),
}))

function addSong(id: string, title: string) {
  mockDb
    .prepare(
      // A source URL per song, since v6 made `songs.source_url` UNIQUE (#310).
      `INSERT INTO songs (id, server_song_id, title, artist, source_url, source_platform, added_at)
       VALUES (?, NULL, ?, 'An Artist', ?, 'youtube', '2026-07-29T00:00:00Z')`,
    )
    .run(id, title, `https://example.com/${id}`)
}

function addPlaylist(id: string, name: string) {
  mockDb
    .prepare(
      `INSERT INTO playlists (id, name, kind, created_at, updated_at)
       VALUES (?, ?, 'user', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z')`,
    )
    .run(id, name)
}

function addItem(playlistId: string, songId: string, position: number) {
  mockDb
    .prepare('INSERT INTO playlist_items (id, playlist_id, song_id, position) VALUES (?, ?, ?, ?)')
    .run(`i-${playlistId}-${songId}`, playlistId, songId, position)
}

/** The song ids in playlist order — the invariant most of these are about. */
function order(playlistId: string): string[] {
  return (
    mockDb
      .prepare('SELECT song_id FROM playlist_items WHERE playlist_id = ? ORDER BY position')
      .all(playlistId) as { song_id: string }[]
  ).map((row) => row.song_id)
}

/** The edit-mode row height the screen declares, so a drag of exactly one row
 *  is one row and not a number that happens to work. */
const ROW_HEIGHT = 60

/** Drive a drag the way `draggableList.test.tsx` does. `runOnJS` is
 *  asynchronous even under jest, so the flush is not optional. */
async function drag(testId: string, translationY: number) {
  fireGestureHandler(getByGestureTestId(testId), [
    { state: State.BEGAN, translationY: 0 },
    { state: State.ACTIVE, translationY },
    { state: State.END, translationY },
  ])
  await act(async () => {})
}

/** The favourites playlist's id. Seeded by the migration, so it is looked up
 *  rather than written — the same way the app finds it. */
function favouritesId(): string {
  return (
    mockDb.prepare("SELECT id FROM playlists WHERE kind = 'favourites'").get() as { id: string }
  ).id
}

/** Retitle seeded songs, for the sort tests. */
function retitle(titles: Record<string, string>) {
  for (const [id, title] of Object.entries(titles)) {
    mockDb.prepare('UPDATE songs SET title = ? WHERE id = ?').run(title, id)
  }
}

/** The song titles in the order they are drawn. Browsing rows are `SongRow`s
 *  labelled "Play <title>"; edit rows are checkboxes labelled "Select <title>". */
/** Whether a node sits inside the selection toolbar rather than the list. */
function inToolbar(node: { parent: unknown }): boolean {
  let current = node as { parent?: unknown; props?: { accessibilityRole?: string } } | undefined
  while (current) {
    if (current.props?.accessibilityRole === 'toolbar') return true
    current = current.parent as typeof current
  }
  return false
}

function shownOrder(): string[] {
  return (
    screen
      .queryAllByLabelText(/^(Play|Select) /)
      // The selection bar's toggle is called "Select all" (#378) — every control
      // has an accessible name now that they are all `Button`s, and this query
      // was written when that one had none. Excluded by *where it is* rather than
      // by its wording, which would break again the next time a label changes.
      .filter((node) => !inToolbar(node))
      .map((node) => String(node.props.accessibilityLabel).replace(/^(Play|Select) /, ''))
  )
}

/** Choose a sort from the sort sheet. */
async function sortBy(label: string) {
  await act(async () => {
    fireEvent.press(screen.getByText('Playlist order'))
  })
  await act(async () => {
    fireEvent.press(screen.getByText(label))
  })
  await act(async () => {})
}

/** Open the playlist's 3-dot settings panel (#237). */
async function openSettings(name = 'Road Trip') {
  await waitFor(() => expect(screen.getByLabelText(`Settings for ${name}`)).toBeTruthy())
  await act(async () => {
    fireEvent.press(screen.getByLabelText(`Settings for ${name}`))
  })
  await act(async () => {})
}

/** Enter edit mode, which is raised from the settings panel. */
async function enterEditMode() {
  await openSettings()
  await act(async () => {
    fireEvent.press(screen.getByText('Edit'))
  })
  await act(async () => {})
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    // `mutations` needs saying separately from `queries` — different option
    // groups, and mutations keep their own five-minute default. It cost 313s of
    // every CI run before it was found (a convention in this repo).
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { gcTime: 0 } },
  })
  return (
    <QueryClientProvider client={client}>
      {/* `GestureDetector` throws without it, and expo-router does not supply
          one — the app has it in `app/_layout.tsx`. */}
      <GestureHandlerRootView>{children}</GestureHandlerRootView>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  mockDb = new DatabaseSync(':memory:')
  for (const migration of MIGRATIONS) mockDb.exec(migration)
  mockPush.mockClear()
  mockBack.mockClear()
  mockScrollToIndex.mockClear()
  jest
    .spyOn(FlatList.prototype, 'scrollToIndex')
    .mockImplementation((...args) => mockScrollToIndex(...args))
  mockRoute.id = 'p1'
  useConnection.setState({ serverUrl: 'http://192.168.1.10:8000', accessKey: null, loaded: true })
  // The queues as well as what is playing: a hand-queued song from an earlier
  // test outlived it, so "this swipe queued exactly one song" could only be
  // asserted by whichever test ran first.
  usePlayer.setState({ current: null, isPlaying: false, userQueue: [], contextQueue: [] })
  globalThis.fetch = jest.fn() as unknown as typeof fetch
})

describe('PlaylistsScreen', () => {
  it('lists the playlists with their song counts', async () => {
    addSong('s1', 'A')
    addSong('s2', 'B')
    addPlaylist('p1', 'Road Trip')
    addItem('p1', 's1', 0)
    addItem('p1', 's2', 1)

    await render(<PlaylistsScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('Road Trip')).toBeTruthy())
    expect(screen.getByText('2 songs')).toBeTruthy()
  })

  it('keeps favourites out of the ordinary list but shows it exactly once', async () => {
    addPlaylist('p1', 'Road Trip')

    await render(<PlaylistsScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('Road Trip')).toBeTruthy())
    // Seeded by the migration, pinned by the query and filtered out of the
    // ordinary list — so it appears once, not twice and not never.
    expect(screen.getAllByText('Favourites')).toHaveLength(1)
  })

  it('opens favourites on the shared playlist screen, by its real id', async () => {
    addSong('s1', 'A')
    addItem(favouritesId(), 's1', 0)

    await render(<PlaylistsScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Favourites')).toBeTruthy())

    // The count comes from the pinned row itself now, not a second query.
    expect(screen.getByText('1 song')).toBeTruthy()

    await act(async () => {
      fireEvent.press(screen.getByText('Favourites'))
    })

    // The id, not `/playlists/favourites` — that route is gone (#291).
    expect(mockPush).toHaveBeenCalledWith(`/playlists/${favouritesId()}`)
  })

  it('reads the device, never the server', async () => {
    addPlaylist('p1', 'Road Trip')

    await render(<PlaylistsScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Road Trip')).toBeTruthy())

    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('shows an empty state when there are no playlists', async () => {
    await render(<PlaylistsScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('No playlists yet.')).toBeTruthy())
  })
})

describe('choosing several playlists at once (#570)', () => {
  /*
   * *"in playlist page, I cannot select or multi select playlist, I want
   * to select multiple playlist at once, to delete, in case if I have too many
   * playlist"*.
   *
   * The same `useSelection` + `SelectionBar` the library got in #336, started
   * by an explicit **Select** button — never a long press, which already means
   * "open the sheet" on a song and "start dragging" inside a playlist.
   */
  const startSelecting = async () => {
    await act(async () => {
      fireEvent.press(screen.getByText('Select'))
    })
  }

  it('deletes the chosen playlists and leaves the rest', async () => {
    addPlaylist('p1', 'Road Trip')
    addPlaylist('p2', 'Study')
    addPlaylist('p3', 'Sleep')

    await render(<PlaylistsScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Road Trip')).toBeTruthy())
    await startSelecting()

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Select Road Trip'))
    })
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Select Sleep'))
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Delete'))
    })

    await waitFor(() => expect(screen.queryByText('Road Trip')).toBeNull())
    expect(screen.queryByText('Sleep')).toBeNull()
    expect(screen.getByText('Study')).toBeTruthy()
    // And selection mode is over. Staying in it after the subject is gone
    // leaves a bar with a count of zero and nothing to act on.
    expect(screen.queryByText('0 selected')).toBeNull()
    expect(screen.getByText('Select')).toBeTruthy()
  })

  it('⚠️ leaves the songs on the device', async () => {
    /*
     * The property most worth pinning, because "delete" means *gone* two taps
     * away: the library's own delete takes the audio with it. A playlist is a
     * list of references, and deleting it must remove the references only.
     *
     * Asserted against the database rather than the screen — the playlists page
     * would look identical either way, which is exactly how this could ship
     * broken.
     */
    addSong('s1', 'A song')
    addPlaylist('p1', 'Road Trip')
    addItem('p1', 's1', 0)

    await render(<PlaylistsScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Road Trip')).toBeTruthy())
    await startSelecting()
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Select Road Trip'))
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Delete'))
    })

    await waitFor(() =>
      expect(mockDb.prepare('SELECT COUNT(*) AS n FROM playlists WHERE id = ?').get('p1')).toEqual({
        n: 0,
      }),
    )
    // The references go…
    expect(
      mockDb.prepare('SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?').get('p1'),
    ).toEqual({ n: 0 })
    // …and the music stays.
    expect(mockDb.prepare('SELECT COUNT(*) AS n FROM songs').get()).toEqual({ n: 1 })
  })

  it('never offers Favourites for selection', async () => {
    /*
     * ⚠️ It is drawn in the list's *header*, not in the list, so it cannot be
     * ticked at all — which is the right place for the protection. A row that
     * can be selected and then refuses to be deleted is a worse experience than
     * one that was never offered. (`deletePlaylists` throws for it as well, as
     * a check on this reasoning rather than as the user's guard rail.)
     */
    addPlaylist('p1', 'Road Trip')

    await render(<PlaylistsScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Road Trip')).toBeTruthy())
    await startSelecting()

    expect(screen.getByLabelText('Select Road Trip')).toBeTruthy()
    expect(screen.queryByLabelText('Select Favourites')).toBeNull()
    // And Select all means the ordinary playlists, not the pinned one.
    await act(async () => {
      fireEvent.press(screen.getByText('Select all'))
    })
    expect(screen.getByText('1 selected')).toBeTruthy()
  })

  it('offers no Select button with nothing to select', async () => {
    // A mode with no possible subject is a button that does nothing.
    await render(<PlaylistsScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('No playlists yet.')).toBeTruthy())
    expect(screen.queryByText('Select')).toBeNull()
  })

  it('opens a playlist on press when it is not selecting', async () => {
    // The control. Selection must not become the only thing a tap can do.
    addPlaylist('p1', 'Road Trip')

    await render(<PlaylistsScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Road Trip')).toBeTruthy())
    await act(async () => {
      fireEvent.press(screen.getByText('Road Trip'))
    })

    expect(mockPush).toHaveBeenCalledWith('/playlists/p1')
  })
})

describe('creating a playlist', () => {
  /** Step one: open the sheet, type a name, confirm it. Leaves the track picker
   *  on screen, which is where every test below carries on from. */
  async function nameIt(name: string) {
    await waitFor(() => expect(screen.getByText('New playlist')).toBeTruthy())
    await act(async () => {
      fireEvent.press(screen.getByText('New playlist'))
    })
    await act(async () => {})
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('New playlist'), name)
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Done'))
    })
    await act(async () => {})
  }

  it('creates it with the name it was given, trimmed, and opens it', async () => {
    await render(<PlaylistsScreen />, { wrapper })
    await nameIt('  Focus  ')

    await act(async () => {
      fireEvent.press(screen.getByText('Create empty'))
    })

    await waitFor(() =>
      expect(mockDb.prepare("SELECT name FROM playlists WHERE kind = 'user'").all()).toEqual([
        { name: 'Focus' },
      ]),
    )
    // Straight into the new playlist, so the result is visible.
    expect(mockPush).toHaveBeenCalled()
  })

  it('will not create a playlist with a blank name', async () => {
    await render(<PlaylistsScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('New playlist')).toBeTruthy())

    await act(async () => {
      fireEvent.press(screen.getByText('New playlist'))
    })
    await act(async () => {})
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('New playlist'), '   ')
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Done'))
    })

    // The name step never settles, so the picker never opens and nothing is
    // written.
    expect(screen.queryByText('Create empty')).toBeNull()
    expect(mockDb.prepare("SELECT COUNT(*) AS n FROM playlists WHERE kind='user'").get()).toEqual({
      n: 0,
    })
  })

  it('creates it with the tracks that were picked, in the order they were tapped', async () => {
    addSong('s1', 'First song')
    addSong('s2', 'Second song')
    addSong('s3', 'Third song')

    await render(<PlaylistsScreen />, { wrapper })
    await nameIt('Focus')

    // Tapped out of list order on purpose: the playlist should come out in tap
    // order, which is what `addSongsToPlaylist` promises.
    await waitFor(() => expect(screen.getByLabelText('Select Third song')).toBeTruthy())
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Select Third song'))
    })
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Select First song'))
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Create with 2 songs'))
    })

    await waitFor(() => {
      const created = mockDb.prepare("SELECT id FROM playlists WHERE kind = 'user'").get() as {
        id: string
      }
      expect(order(created.id)).toEqual(['s3', 's1'])
    })
  })

  it('takes tracks from another playlist, and keeps them when the source changes', async () => {
    addSong('s1', 'First song')
    addSong('s2', 'Second song')
    addPlaylist('p1', 'Road Trip')
    addItem('p1', 's2', 0)

    await render(<PlaylistsScreen />, { wrapper })
    await nameIt('Mixtape')

    // From the library...
    await waitFor(() => expect(screen.getByLabelText('Select First song')).toBeTruthy())
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Select First song'))
    })
    // ...then switch source to an existing playlist. The selection has to
    // survive the switch or picking from two sources is impossible.
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Show songs from Road Trip'))
    })
    await waitFor(() => expect(screen.getByLabelText('Select Second song')).toBeTruthy())
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Select Second song'))
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Create with 2 songs'))
    })

    await waitFor(() => {
      const created = mockDb
        .prepare("SELECT id FROM playlists WHERE kind = 'user' AND name = 'Mixtape'")
        .get() as { id: string }
      expect(order(created.id)).toEqual(['s1', 's2'])
    })
  })

  it('writes nothing when the track picker is cancelled', async () => {
    addSong('s1', 'First song')

    await render(<PlaylistsScreen />, { wrapper })
    await nameIt('Abandoned')

    await waitFor(() => expect(screen.getByLabelText('Select First song')).toBeTruthy())
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Select First song'))
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Cancel'))
    })
    await act(async () => {})

    // The whole reason creation is two steps with nothing written in between:
    // backing out must not leave a stray empty playlist behind.
    expect(mockDb.prepare("SELECT COUNT(*) AS n FROM playlists WHERE kind='user'").get()).toEqual({
      n: 0,
    })
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('filters the pickable songs by the search box', async () => {
    addSong('s1', 'Alpha')
    addSong('s2', 'Beta')

    await render(<PlaylistsScreen />, { wrapper })
    await nameIt('Focus')

    await waitFor(() => expect(screen.getByLabelText('Select Alpha')).toBeTruthy())
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Search songs to add'), 'bet')
    })

    expect(screen.queryByLabelText('Select Alpha')).toBeNull()
    expect(screen.getByLabelText('Select Beta')).toBeTruthy()
  })
})

describe('PlaylistDetailScreen', () => {
  beforeEach(() => {
    addSong('s1', 'First song')
    addSong('s2', 'Second song')
    addSong('s3', 'Third song')
    addPlaylist('p1', 'Road Trip')
    addItem('p1', 's1', 0)
    addItem('p1', 's2', 1)
    addItem('p1', 's3', 2)
  })

  it('shows the playlist name and its songs in playlist order', async () => {
    await render(<PlaylistDetailScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('Road Trip')).toBeTruthy())
    expect(screen.getByText('First song')).toBeTruthy()
    expect(screen.getByText('Third song')).toBeTruthy()
  })

  it('says so when a playlist has no songs', async () => {
    mockDb.prepare('DELETE FROM playlist_items').run()

    await render(<PlaylistDetailScreen />, { wrapper })

    await waitFor(() => expect(screen.getByText('This playlist is empty.')).toBeTruthy())
  })

  it('removes a song by its item id, and closes the gap', async () => {
    await render(<PlaylistDetailScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Second song')).toBeTruthy())

    await act(async () => {
      fireEvent(screen.getByLabelText('Play Second song'), 'longPress')
    })
    await act(async () => {})
    await act(async () => {
      fireEvent.press(screen.getByText('Remove from this playlist'))
    })

    // Dense positions are the invariant: a gap makes "move to position 1"
    // ambiguous and breaks the UNIQUE index's promise.
    await waitFor(() => expect(order('p1')).toEqual(['s1', 's3']))
  })

  it('renames a playlist, starting from the name it already has', async () => {
    await render(<PlaylistDetailScreen />, { wrapper })
    await openSettings()

    await act(async () => {
      fireEvent.press(screen.getByText('Rename'))
    })
    await act(async () => {})
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Rename'), 'Commute')
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Save'))
    })

    await waitFor(() =>
      expect(mockDb.prepare('SELECT name FROM playlists WHERE id = ?').get('p1')).toEqual({
        name: 'Commute',
      }),
    )
  })

  it('asks before deleting, and goes back once it has', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {})

    await render(<PlaylistDetailScreen />, { wrapper })
    await openSettings()
    await act(async () => {
      fireEvent.press(screen.getByText('Delete'))
    })

    const [title, , buttons] = alert.mock.calls[0]
    expect(title).toBe('Delete playlist?')

    await act(async () => {
      ;(buttons as { text: string; onPress?: () => void }[])
        .find((button) => button.text === 'Delete')
        ?.onPress?.()
    })

    await waitFor(() => expect(mockBack).toHaveBeenCalled())
    // The items go with it — explicitly, since SQLite ignores ON DELETE CASCADE
    // unless `PRAGMA foreign_keys` is on.
    expect(mockDb.prepare('SELECT COUNT(*) AS n FROM playlist_items').get()).toEqual({ n: 0 })
    alert.mockRestore()
  })

  it('reorders by dragging, writing the whole new order', async () => {
    await render(<PlaylistDetailScreen />, { wrapper })
    await enterEditMode()

    // One row-height down moves "First song" past "Second song". The arrow
    // buttons this replaces could only ever move one place at a time (#236).
    await drag('drag-0', ROW_HEIGHT)

    // The two-pass write is what makes this possible at all: a single pass
    // collides with the row already at the target position.
    await waitFor(() => expect(order('p1')).toEqual(['s2', 's1', 's3']))
  })

  it('adds tracks from the settings panel, without duplicating what is there', async () => {
    addSong('s4', 'Fourth song')

    await render(<PlaylistDetailScreen />, { wrapper })
    await openSettings()
    await act(async () => {
      fireEvent.press(screen.getByText('Add songs'))
    })

    // Songs already in the playlist are shown but not selectable — visible so
    // the list is not mysteriously short, disabled so a duplicate cannot happen
    // by mis-tap.
    await waitFor(() => expect(screen.getByLabelText('Select Fourth song')).toBeTruthy())
    expect(screen.getByLabelText('Select First song').props.accessibilityState.disabled).toBe(true)
    // One per song already in the playlist: s1, s2 and s3.
    expect(screen.getAllByText('Already in')).toHaveLength(3)

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Select Fourth song'))
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Add 1 song'))
    })

    await waitFor(() => expect(order('p1')).toEqual(['s1', 's2', 's3', 's4']))
  })

  it('removes several ticked songs at once, and closes the gaps', async () => {
    await render(<PlaylistDetailScreen />, { wrapper })
    await enterEditMode()

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Select First song'))
    })
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Select Third song'))
    })
    await act(async () => {
      fireEvent.press(screen.getByText('Remove'))
    })

    // Dense positions are the invariant the issue names explicitly.
    await waitFor(() => expect(order('p1')).toEqual(['s2']))
    expect(
      mockDb.prepare('SELECT position FROM playlist_items WHERE playlist_id = ?').all('p1'),
    ).toEqual([{ position: 0 }])
  })

  it('sorts the view without rewriting the playlist', async () => {
    // Titles whose alphabetical order differs from playlist order, or "sorted"
    // and "unsorted" look identical and the test proves nothing.
    retitle({ s1: 'Zebra', s2: 'Apple', s3: 'Mango' })

    await render(<PlaylistDetailScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Playlist order')).toBeTruthy())
    expect(shownOrder()).toEqual(['Zebra', 'Apple', 'Mango'])

    await sortBy('Title (A–Z)')

    // The view really did change...
    expect(shownOrder()).toEqual(['Apple', 'Mango', 'Zebra'])
    // ...and the stored order did not. Writing it back would silently destroy
    // the order the user arranged by hand. Flushed first, so an async write
    // would have landed by now rather than being missed.
    await act(async () => {})
    expect(order('p1')).toEqual(['s1', 's2', 's3'])
  })

  it('drops the sort when edit mode starts, so the list stays what was dragged', async () => {
    retitle({ s1: 'Zebra', s2: 'Apple', s3: 'Mango' })

    await render(<PlaylistDetailScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Playlist order')).toBeTruthy())
    await sortBy('Title (A–Z)')
    expect(shownOrder()).toEqual(['Apple', 'Mango', 'Zebra'])

    await enterEditMode()
    // Edit mode always draws playlist order, so what is dragged is what moves.
    expect(shownOrder()).toEqual(['Zebra', 'Apple', 'Mango'])
    await drag('drag-0', ROW_HEIGHT)
    await waitFor(() => expect(order('p1')).toEqual(['s2', 's1', 's3']))

    // And leaving edit mode does not restore the old sort behind the user's
    // back: the list they just rearranged is the list they keep looking at.
    await act(async () => {
      fireEvent.press(screen.getByText('Done'))
    })
    await act(async () => {})
    expect(screen.getByText('Playlist order')).toBeTruthy()
    expect(shownOrder()).toEqual(['Apple', 'Zebra', 'Mango'])
  })

  it('replaces the playback queue from the settings panel', async () => {
    await render(<PlaylistDetailScreen />, { wrapper })
    await openSettings()

    await act(async () => {
      fireEvent.press(screen.getByText('Play now (replace the queue)'))
    })

    const state = usePlayer.getState()
    expect(state.contextQueue.map((song) => song.id)).toEqual(['s1', 's2', 's3'])
    expect(state.current?.song.id).toBe('s1')
  })

  it('appends to the playback queue without disturbing what is playing or hand-queued', async () => {
    // Something already playing, from a different list, with a hand-queued song
    // behind it — the exact state ADR-011 says must survive.
    const other = { id: 'other', title: 'Other', artist: 'X' } as never
    const queued = { id: 'queued', title: 'Queued', artist: 'X' } as never
    await act(async () => {
      usePlayer.getState().playFromContext([other], 0, { kind: 'playlist', name: 'Other list' })
      usePlayer.getState().addToQueue(queued)
    })

    await render(<PlaylistDetailScreen />, { wrapper })
    await openSettings()
    await act(async () => {
      fireEvent.press(screen.getByText('Play after the current queue'))
    })

    const state = usePlayer.getState()
    // Appended, not replaced: what was playing keeps playing.
    expect(state.current?.song.id).toBe('other')
    expect(state.contextQueue.map((song) => song.id)).toEqual(['other', 's1', 's2', 's3'])
    // And the hand-built queue is untouched, which is the promise.
    expect(state.userQueue.map((song) => song.id)).toEqual(['queued'])
  })

  /**
   * Swipe right to queue, here too (#402).
   *
   * *"[swipe] worked perfect. but i want swipe right to queue on tracks
   * in playlist as well, not just in library"*. `SongRow` has taken the handler
   * since #379 and this screen did not pass it — the absent handler creates no
   * gesture at all, which is the deliberate default, not an oversight.
   */
  it('queues a song swiped right, without disturbing what is playing', async () => {
    const other = { id: 'other', title: 'Other', artist: 'X' } as never
    await act(async () => {
      usePlayer.getState().playFromContext([other], 0, { kind: 'playlist', name: 'Other list' })
    })
    await render(<PlaylistDetailScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Second song')).toBeTruthy())

    await act(async () => {
      fireGestureHandler(getByGestureTestId('swipe-s2'), [
        { state: State.BEGAN, translationX: 0 },
        { state: State.ACTIVE, translationX: 140 },
        { state: State.END, translationX: 140 },
      ])
    })

    // The hand-built queue, not the context: a swipe is "play this next", and
    // what is playing is untouched.
    expect(usePlayer.getState().userQueue.map((song) => song.id)).toEqual(['s2'])
    expect(usePlayer.getState().current?.song.id).toBe('other')
  })

  it('offers no swipe on the edit-mode rows, which are the drag targets', async () => {
    // ADR-018's composition question does not arise here, and this is why:
    // edit mode does not render `SongRow` at all, so the drag and the swipe are
    // never on the same row. Read rather than assumed, because #402 asked.
    await render(<PlaylistDetailScreen />, { wrapper })
    await waitFor(() => expect(screen.getByText('Second song')).toBeTruthy())

    await act(async () => {
      fireEvent.press(screen.getByText('Select'))
    })

    expect(() => getByGestureTestId('swipe-s2')).toThrow()
  })

  it('searches within the playlist without touching the stored order', async () => {
    retitle({ s1: 'Zebra', s2: 'Apple', s3: 'Mango' })

    await render(<PlaylistDetailScreen />, { wrapper })
    await waitFor(() => expect(screen.getByLabelText('Search this playlist')).toBeTruthy())

    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Search this playlist'), 'mang')
    })
    await act(async () => {})

    // "Mango" matches on title; the others do not. Note the needle avoids "an",
    // which would match every row's artist ("An Artist") and prove nothing.
    expect(shownOrder()).toEqual(['Mango'])
    expect(order('p1')).toEqual(['s1', 's2', 's3'])
  })

  it('matches on artist as well as title', async () => {
    mockDb.prepare('UPDATE songs SET artist = ? WHERE id = ?').run('Miles Davis', 's2')

    await render(<PlaylistDetailScreen />, { wrapper })
    await waitFor(() => expect(screen.getByLabelText('Search this playlist')).toBeTruthy())

    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Search this playlist'), 'miles')
    })
    await act(async () => {})

    expect(shownOrder()).toEqual(['Second song'])
  })

  it('says nothing matched rather than claiming the playlist is empty', async () => {
    await render(<PlaylistDetailScreen />, { wrapper })
    await waitFor(() => expect(screen.getByLabelText('Search this playlist')).toBeTruthy())

    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Search this playlist'), 'zzzz')
    })
    await act(async () => {})

    expect(screen.getByText('No songs in this playlist match "zzzz".')).toBeTruthy()
    // The wrong message here would send someone looking for songs they have.
    expect(screen.queryByText('This playlist is empty.')).toBeNull()
  })

  it('clears the search when edit mode starts, so the whole playlist is dragged', async () => {
    retitle({ s1: 'Zebra', s2: 'Apple', s3: 'Mango' })

    await render(<PlaylistDetailScreen />, { wrapper })
    await waitFor(() => expect(screen.getByLabelText('Search this playlist')).toBeTruthy())
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Search this playlist'), 'mang')
    })
    await act(async () => {})
    expect(shownOrder()).toEqual(['Mango'])

    await enterEditMode()

    // All three rows are back, in playlist order: a drag against a filtered
    // list would write positions unrelated to what moved.
    expect(shownOrder()).toEqual(['Zebra', 'Apple', 'Mango'])
    await drag('drag-0', ROW_HEIGHT)
    await waitFor(() => expect(order('p1')).toEqual(['s2', 's1', 's3']))

    // And the query is really gone rather than merely ignored while editing:
    // leaving edit mode must not restore a filter over the list the user just
    // rearranged.
    await act(async () => {
      fireEvent.press(screen.getByText('Done'))
    })
    await act(async () => {})
    expect(screen.getByLabelText('Search this playlist').props.value).toBe('')
    expect(shownOrder()).toEqual(['Apple', 'Zebra', 'Mango'])
  })

  it('opens scrolled to the playing track', async () => {
    await act(async () => {
      usePlayer.setState({
        current: { source: 'context', song: { id: 's3', title: 'Third song' } as never },
      })
    })

    await render(<PlaylistDetailScreen />, { wrapper })
    await waitFor(() => expect(screen.getByLabelText('Play Third song')).toBeTruthy())
    await act(async () => {})

    // Index 2 of the playlist, centred rather than pinned to the top.
    expect(mockScrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({ index: 2, viewPosition: 0.5 }),
    )
  })

  it('does not scroll when the playing track is not in this playlist', async () => {
    await act(async () => {
      usePlayer.setState({
        current: { source: 'context', song: { id: 'elsewhere', title: 'Elsewhere' } as never },
      })
    })

    await render(<PlaylistDetailScreen />, { wrapper })
    await waitFor(() => expect(screen.getByLabelText('Play First song')).toBeTruthy())
    await act(async () => {})

    // "nothing jumps when it is not in the list" (#239).
    expect(mockScrollToIndex).not.toHaveBeenCalled()
  })

  it('scrolls once, not every time the track changes', async () => {
    await act(async () => {
      usePlayer.setState({
        current: { source: 'context', song: { id: 's3', title: 'Third song' } as never },
      })
    })

    await render(<PlaylistDetailScreen />, { wrapper })
    await waitFor(() => expect(screen.getByLabelText('Play Third song')).toBeTruthy())
    await act(async () => {})
    expect(mockScrollToIndex).toHaveBeenCalledTimes(1)

    // A track advancing must not yank a list the user may be scrolling.
    await act(async () => {
      usePlayer.setState({
        current: { source: 'context', song: { id: 's2', title: 'Second song' } as never },
      })
    })
    await act(async () => {})

    expect(mockScrollToIndex).toHaveBeenCalledTimes(1)
  })

  it('hearts a song from an ordinary playlist, and keeps the row', async () => {
    await render(<PlaylistDetailScreen />, { wrapper })
    await waitFor(() => expect(screen.getByLabelText('Add First song to favourites')).toBeTruthy())

    await act(async () => {
      fireEvent.press(screen.getByLabelText('Add First song to favourites'))
    })

    // The heart fills — and the row stays, because this is not the favourites
    // list. Both halves matter: an implementation that dropped the row would
    // pass an assertion about the heart alone.
    await waitFor(() =>
      expect(screen.getByLabelText('Remove First song from favourites')).toBeTruthy(),
    )
    expect(screen.getByText('First song')).toBeTruthy()
    expect(order(favouritesId())).toEqual(['s1'])
  })

  it('does not offer to rename or delete favourites', async () => {
    mockRoute.id = favouritesId()
    // Favourites needs contents, or the sheet omits the queue actions too and
    // the assertion below could pass because the sheet is simply short.
    addItem(mockRoute.id, 's1', 0)

    await render(<PlaylistDetailScreen />, { wrapper })
    await openSettings('Favourites')

    // The sheet really is open — without this the two queryByText assertions
    // would pass on a screen with no sheet at all.
    expect(screen.getByText('Add songs')).toBeTruthy()
    // The store refuses both; the rule survives the move into the sheet.
    expect(screen.queryByText('Rename')).toBeNull()
    expect(screen.queryByText('Delete')).toBeNull()
  })

  /**
   * Favourites through the shared screen (#291).
   *
   * These came off `favourites.test.tsx`, which tested a screen that no longer
   * exists. They are stronger here: that file mocked `library/playlists`
   * wholesale, so "un-hearting drops the row" was really "the mock removed it
   * from an array". Against real SQLite, the drop and the write are the same
   * fact.
   */
  describe('favourites', () => {
    beforeEach(() => {
      mockRoute.id = favouritesId()
      addItem(mockRoute.id, 's1', 0)
      addItem(mockRoute.id, 's2', 1)
    })

    it('shows every heart filled, since everything here is hearted', async () => {
      await render(<PlaylistDetailScreen />, { wrapper })

      await waitFor(() =>
        expect(screen.getByLabelText('Remove First song from favourites')).toBeTruthy(),
      )
      expect(screen.getByLabelText('Remove Second song from favourites')).toBeTruthy()
    })

    it('un-hearting drops the row and the row alone', async () => {
      await render(<PlaylistDetailScreen />, { wrapper })
      await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())

      await act(async () => {
        fireEvent.press(screen.getByLabelText('Remove First song from favourites'))
      })

      await waitFor(() => expect(screen.queryByText('First song')).toBeNull())
      expect(screen.getByText('Second song')).toBeTruthy()
      expect(order(favouritesId())).toEqual(['s2'])
    })

    it('works for a song the server has never heard of', async () => {
      // The reason favourites moved to the device (#219): every seeded song has
      // a null `server_song_id`, so this relationship could not have lived on
      // the server at all.
      expect(mockDb.prepare('SELECT server_song_id FROM songs WHERE id = ?').get('s1')).toEqual({
        server_song_id: null,
      })

      await render(<PlaylistDetailScreen />, { wrapper })
      await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())

      expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    it('gets T5: it can be searched, which is the whole point of the move', async () => {
      await render(<PlaylistDetailScreen />, { wrapper })
      await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())

      await act(async () => {
        fireEvent.changeText(screen.getByLabelText('Search this playlist'), 'Second')
      })

      expect(shownOrder()).toEqual(['Second song'])
    })

    it('gets T5: it has a settings panel and an edit mode', async () => {
      await render(<PlaylistDetailScreen />, { wrapper })
      await openSettings('Favourites')

      expect(screen.getByText('Edit')).toBeTruthy()
    })

    it('says how to fill it, rather than telling you to add songs to it', async () => {
      mockDb.prepare('DELETE FROM playlist_items').run()

      await render(<PlaylistDetailScreen />, { wrapper })

      await waitFor(() => expect(screen.getByText('No favourites yet')).toBeTruthy())
      // Not the ordinary playlist's empty state, which names a thing you do not
      // do to favourites.
      expect(screen.queryByText('This playlist is empty.')).toBeNull()
    })

    it('plays the whole list as a context, not one song at a time', async () => {
      await render(<PlaylistDetailScreen />, { wrapper })
      await waitFor(() => expect(screen.getByText('First song')).toBeTruthy())

      await act(async () => {
        fireEvent.press(screen.getByLabelText('Play First song'))
      })

      // Playing from favourites should keep playing *through* favourites.
      const state = usePlayer.getState()
      expect(state.context?.kind).toBe('playlist')
      expect(state.context?.name).toBe('Favourites')
      expect(state.contextQueue).toHaveLength(2)
    })
  })
})

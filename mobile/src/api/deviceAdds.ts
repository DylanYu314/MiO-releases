import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'

import type { FailureKind } from '../library/failureKind'
import { createJSONStorage, persist } from 'zustand/middleware'

/** How many are kept. The same figure `useActiveImports` uses, for the same
 *  reason: this is a record of what happened, not an archive. */
const MAX_RECORDS = 20

export type DeviceAddStatus = 'working' | 'done' | 'failed'

/** Where the user was when they added it, so each page can show its own. */
export type DeviceAddSource = 'link' | 'search' | 'import'

/** The steps one add goes through. The same three `DeviceImportProgress` has
 *  always reported — they simply had nowhere durable to be recorded. */
export type DeviceAddPhase = 'extracting' | 'downloading' | 'saving'

export interface DeviceAdd {
  /** The source URL, which is what identifies one attempt at one video —
   *  adding the same link twice is the same record, tried again. */
  url: string
  source: DeviceAddSource
  status: DeviceAddStatus
  /** Known from the moment extraction answers; null while it is still a URL. */
  title: string | null
  artist: string | null
  thumbnail: string | null
  /** Why it failed, in the user's language where we have one. */
  error: string | null
  /**
   * What *kind* of failure it was (#441).
   *
   * Separate from `error`, which is a sentence, because the kind is what the
   * screen reasons about: whether to offer "try again" at all, and whether to
   * suggest a different source instead. Optional, because records persisted
   * before this existed rehydrate without it.
   */
  failure?: FailureKind | null
  /**
   * Which step this add is on, while it is still `working` (#430).
   *
   * Null until the first report, and on records written before this existed.
   *
   * A status of `working` was the *only* thing this list could say, and that
   * turned out to be nowhere near enough: `importToDevice` walks four YouTube
   * clients and each attempt's download is bounded at five minutes, so a bare
   * spinner can honestly sit there for twenty minutes. I waited "so long"
   * on one while Diagnostics filled with refusals behind it, and a slow add and
   * a stuck one looked identical — which is the same fault the playlist import
   * fixed with a phase in #370.
   *
   * **Optional, not merely nullable.** These records are `persist`ed, so a
   * phone upgrading into this build rehydrates rows written without them —
   * declaring them required would be the type lying about data already on disk.
   */
  phase?: DeviceAddPhase | null
  /** Which client attempt is in hand, 1-based. Absent before the first report. */
  attempt?: number | null
  /** How many there are in total, so "2 of 4" is sayable rather than "2". */
  attempts?: number | null
  startedAt: number
  finishedAt: number | null
}

interface DeviceAddsState {
  adds: DeviceAdd[]
  /** A new attempt, or a fresh attempt at one that failed before. */
  started: (url: string, source: DeviceAddSource) => void
  /** What extraction learned, before the bytes arrive. */
  describe: (
    url: string,
    about: { title: string; artist: string; thumbnail?: string | null },
  ) => void
  /** Where the add has got to, so the row can say more than "working". */
  progressed: (
    url: string,
    at: { phase: DeviceAddPhase; attempt: number; attempts: number },
  ) => void
  succeeded: (url: string) => void
  failed: (url: string, error: string | null, failure?: FailureKind | null) => void
  forget: (url: string) => void
  clearFinished: () => void
}

/**
 * What this device has tried to add, and how it went (#318).
 *
 * ## Why it exists
 *
 * *"still no tracking of fetch, download for add link, search then add
 * link… if the user adds the link and quits before the track is downloaded…
 * when they come back they need to see what was added successfully, what
 * failed, and what was interrupted."*
 *
 * `useActiveImports` records the **server** path — it is keyed on a numeric job
 * id, and the device path has no such thing. So a device add, which is now the
 * only way most music arrives, was recorded nowhere at all: the add-link screen
 * kept it in `useState` and leaving the screen lost it.
 *
 * ## Keyed on the URL, not on an id we mint
 *
 * One pasted link is one thing the user is waiting on, however many attempts it
 * takes underneath — the same judgement `useActiveImports.retried` makes. Trying
 * a failed link again updates its record rather than growing a second one.
 *
 * ## "Interrupted" is not a status
 *
 * There is no moment at which the app can write "interrupted": the process is
 * gone. A record still saying `working` when the app *starts* is the
 * interrupted one, and {@link markInterrupted} is what says so — once, at
 * launch, before anything new can be started.
 */
export const useDeviceAdds = create<DeviceAddsState>()(
  persist(
    (set) => ({
      adds: [],

      started: (url, source) =>
        set((state) => ({
          adds: [
            {
              url,
              source,
              status: 'working' as const,
              title: null,
              artist: null,
              thumbnail: null,
              error: null,
              failure: null,
              phase: null,
              attempt: null,
              attempts: null,
              startedAt: Date.now(),
              finishedAt: null,
            },
            ...state.adds.filter((add) => add.url !== url),
          ].slice(0, MAX_RECORDS),
        })),

      describe: (url, about) =>
        set((state) => ({
          adds: state.adds.map((add) =>
            add.url === url
              ? {
                  ...add,
                  title: about.title,
                  artist: about.artist,
                  thumbnail: about.thumbnail ?? add.thumbnail,
                }
              : add,
          ),
        })),

      progressed: (url, at) =>
        set((state) => ({
          adds: state.adds.map((add) =>
            add.url === url
              ? { ...add, phase: at.phase, attempt: at.attempt, attempts: at.attempts }
              : add,
          ),
        })),

      succeeded: (url) =>
        set((state) => ({
          adds: state.adds.map((add) =>
            add.url === url
              ? {
                  ...add,
                  status: 'done' as const,
                  error: null,
                  phase: null,
                  finishedAt: Date.now(),
                }
              : add,
          ),
        })),

      failed: (url, error, failure = null) =>
        set((state) => ({
          adds: state.adds.map((add) =>
            add.url === url
              ? {
                  ...add,
                  status: 'failed' as const,
                  error,
                  failure,
                  phase: null,
                  finishedAt: Date.now(),
                }
              : add,
          ),
        })),

      forget: (url) => set((state) => ({ adds: state.adds.filter((add) => add.url !== url) })),

      clearFinished: () =>
        set((state) => ({ adds: state.adds.filter((add) => add.status === 'working') })),
    }),
    {
      name: 'mio-device-adds',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
)

/**
 * Anything still marked `working` at launch was interrupted — say so.
 *
 * Called once, from the root layout, after the store has rehydrated and before
 * anything new is started. A download does not survive the process, so a record
 * that outlived one was cut off: the app was killed, or Android stopped the
 * JavaScript. Leaving it as "working" would show a spinner for a download that
 * nothing is doing, which is the class of lie this whole iteration is about.
 */
export function markInterrupted(): void {
  const { adds } = useDeviceAdds.getState()
  if (!adds.some((add) => add.status === 'working')) return
  useDeviceAdds.setState({
    adds: adds.map((add) =>
      add.status === 'working'
        ? { ...add, status: 'failed' as const, error: 'interrupted', finishedAt: Date.now() }
        : add,
    ),
  })
}

/** Test seam: module state outlives the test that wrote to it. */
export function resetDeviceAdds(): void {
  useDeviceAdds.setState({ adds: [] })
}

import { useEffect } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { create } from 'zustand'

import { useThemedStyles, type Theme } from '../theme'

/**
 * A sentence that appears, says one thing, and goes (#379).
 *
 * Swiping a row to queue it did the thing and said nothing (UI 7), which on a
 * gesture with no visible result is indistinguishable from a gesture that
 * missed. It is the same complaint as #377's *"there is no hint and
 * indication"*, one screen further on: the app knows something happened and
 * does not mention it.
 *
 * ## Why not `ToastAndroid`
 *
 * `PlaylistPicker` recorded the reason in #234 and it still holds: a native
 * toast is invisible behind an open modal, and this app puts sheets over
 * everything. Its confirmations therefore have to be part of the app's own
 * tree. This is that, made general — mounted once at the root so any screen can
 * reach it, rather than a fourth screen inventing a fourth answer.
 *
 * ## Deliberately not a queue of messages
 *
 * A second message replaces the first and restarts the clock. Stacking them
 * would let a fast series of swipes build a backlog that outlives the action it
 * describes, and "queued" three times is not three pieces of information.
 */

/** How long a message stays up. Long enough to read six words, short enough
 *  that it is gone before it is in the way. */
const VISIBLE_MS = 2200

interface ToastState {
  message: string | null
  show: (message: string) => void
  hide: () => void
}

export const useToast = create<ToastState>((set) => ({
  message: null,
  show: (message) => set({ message }),
  hide: () => set({ message: null }),
}))

/** Say something, from anywhere, without threading a prop through four screens. */
export function showToast(message: string) {
  useToast.getState().show(message)
}

export function Toast() {
  const styles = useThemedStyles(makeStyles)
  const message = useToast((state) => state.message)
  const hide = useToast((state) => state.hide)

  useEffect(() => {
    if (message === null) return
    const timer = setTimeout(hide, VISIBLE_MS)
    // Cleared on the way out, so a replacement message gets the full time
    // rather than inheriting the remainder of the one it replaced.
    return () => clearTimeout(timer)
  }, [message, hide])

  if (message === null) return null

  return (
    <View style={styles.wrapper} pointerEvents="none">
      <View style={styles.toast}>
        {/* `polite`, not `assertive`: this is a confirmation, and interrupting
            a screen reader mid-sentence to say "queued" is worse than waiting. */}
        <Text style={styles.text} accessibilityLiveRegion="polite" numberOfLines={2}>
          {message}
        </Text>
      </View>
    </View>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    // Above the tab bar and the mini player, both of which sit at the bottom.
    wrapper: {
      position: 'absolute',
      left: 16,
      right: 16,
      bottom: 150,
      alignItems: 'center',
    },
    toast: {
      backgroundColor: theme.surfaceMuted,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      paddingHorizontal: 16,
      paddingVertical: 10,
      maxWidth: '100%',
    },
    text: { fontSize: 13, color: theme.text },
  })

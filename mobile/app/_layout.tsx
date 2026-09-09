/*
 * Before anything else, and for its side effect only (#492).
 *
 * Hermes ships no `TextEncoder` — measured against the APK itself, not assumed
 * — and `qrcode`, under `react-native-qrcode-svg`, calls it to encode the QR
 * payload. Node has one, so every test passes either way; the device would
 * throw. Installed here rather than in the screen so the order cannot depend on
 * which module happens to be imported first.
 */
import '../src/polyfills/textEncoder'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { useConnection } from '../src/api/connection'
import { loadInstallId, useInstallReady } from '../src/api/installId'
import { ErrorBoundary } from '../src/components/ErrorBoundary'
import { markInterrupted, useDeviceAdds } from '../src/api/deviceAdds'
import { OnboardingOverlay } from '../src/components/OnboardingOverlay'
import { Toast } from '../src/components/Toast'
import { UpdateBanner } from '../src/components/UpdateBanner'
import { consumePendingShare, onShare } from '../modules/mio-share-intent'
import { isOnAddLink, useSharedText } from '../src/library/sharedText'
import { shouldShowTour, useOnboarding } from '../src/onboarding/store'
import { describeError, logInfo, logWarn, useDiagnostics } from '../src/diagnostics/log'
import { reportCapabilities } from '../src/diagnostics/capabilities'
import { uploadLogIfDue } from '../src/diagnostics/upload'
import { removeIncompleteSongs } from '../src/library/songs'
import { loadAudioSettings } from '../src/player/audioSettings'
import { PlayerHost } from '../src/player/PlayerHost'
import { loadStoredLanguage } from '../src/i18n'
import { loadTheme, useTheme } from '../src/theme'
import { loadSearchSource } from '../src/library/searchSource'

// One client for the app's lifetime.
const queryClient = new QueryClient()

/**
 * The root route. Everything the whole app needs is provided from here.
 *
 * It also owns the "is this app set up yet?" redirect: the app is a client, so
 * without a server address there is nothing any other screen can show.
 */
export default function RootLayout() {
  const { loaded, load } = useConnection()
  const installReady = useInstallReady((state) => state.ready)
  const router = useRouter()
  const segments = useSegments()
  const theme = useTheme()

  /**
   * Nothing renders until the app knows who it is (#188).
   *
   * Both values live in async storage, and screens fire their queries the moment
   * they mount. Starting them first meant every cold start sent its opening
   * requests with no `X-Install-Id`: writes answered 400 ("A client identifier is
   * required"), and — worse, because it looks like data loss rather than a bug —
   * reads answered 200 with an **empty library**.
   *
   * Holding the shell back fixes the whole class at once. The alternative,
   * awaiting the id inside `apiFetch`, makes every request pay for it and hides
   * the ordering problem rather than removing it.
   */
  const ready = loaded && installReady

  useEffect(() => {
    // Started here, but the app waits on `ready` above rather than on these
    // calls having been *made* — the distinction #188 turned on.
    void loadInstallId()
    void load()
    // A chosen language lives on disk, so it can only be applied after startup;
    // see the note in src/i18n.ts.
    void loadStoredLanguage()
    void loadAudioSettings()
    // Same treatment as the language: the app paints in the system theme and
    // corrects a tick later, which is visible only to someone who has overridden
    // it, and only for one frame (#227).
    void loadTheme()
    // Which site to search, remembered across launches (#551). Not awaited:
    // no search can happen before the first paint, so there is nothing to race.
    void loadSearchSource()
    /*
     * Anything the last run left mid-download was interrupted (#318).
     *
     * There is no moment at which the app can write that down — the process is
     * gone. A record still saying "working" at launch is the interrupted one,
     * and saying so here, once, is the only place it can be said. Awaited on
     * rehydration so it does not run against an empty store and find nothing.
     */
    void useDeviceAdds.persist.rehydrate()?.then?.(markInterrupted)
    /*
     * The daily log handshake (#322).
     *
     * On launch rather than on a timer, because there is no reliable background
     * execution here — a `setInterval` only runs while someone is looking at
     * the app. "The first launch of the day" is what can actually be delivered.
     *
     * Awaited on rehydration for the same reason as the record above: run
     * against an empty store it would see no entries and no `lastUploadedAt`,
     * upload nothing, and then mark today as done.
     */
    void useDiagnostics.persist.rehydrate()?.then?.(() => {
      // After rehydration, so the line survives into the store rather than
      // being written to an empty one and overwritten by it.
      reportCapabilities()
      void uploadLogIfDue()
    })
    /*
     * And the library rows that record went with (#369).
     *
     * `markInterrupted` above says so about the *add* the process died in the
     * middle of; this says so about the row it left in the library. A row with
     * no file is a song that will not play, and there is no later moment at
     * which the app can notice — nothing is downloading yet at launch, so
     * nothing live can be taken away by mistake.
     */
    void removeIncompleteSongs()
      .then((removed) => {
        if (removed > 0) logInfo('library.sweptIncomplete', `${removed} rows`)
      })
      // Housekeeping, and never a reason the app does not open. It is the first
      // thing here that touches the library database, so it is also the first
      // that can fail on a device whose migration has not run yet — and "the
      // app will not start" is a far worse outcome than a stale row.
      .catch((error: unknown) => logWarn('library.sweepFailed', describeError(error)))
  }, [load])

  /*
   * The current route, readable from inside the share handler without making
   * that subscription depend on navigation.
   *
   * Its own effect, not an assignment during render: `react-hooks/refs` forbids
   * writing a ref while rendering, and rightly — but the share listener must
   * not re-register on every navigation either, or a share arriving during the
   * gap is lost. A separate effect satisfies both. The handler reads this long
   * after any render, so an effect-updated value is never stale for it.
   */
  const segmentsRef = useRef(segments)
  useEffect(() => {
    segmentsRef.current = segments
  }, [segments])

  /*
   * A link shared into MiO from another app (#573).
   *
   * Here rather than on the Add-link screen because a share arrives at the
   * **root**: as the launch intent on a cold start, and through `onNewIntent`
   * on a warm one — and the warm case is the common one, since MiO is usually
   * already open in the background when somebody shares to it. Neither reaches
   * a screen that is not mounted.
   *
   * ⚠️ Guarded on `ready` for the same reason the setup redirect below is:
   * navigating before the navigator exists does nothing, silently, and a
   * dropped share is indistinguishable from a broken feature.
   *
   * The text is *offered* rather than pushed into a route parameter — see
   * `sharedText.ts` for why a param would re-fill the box every time the user
   * came back to the screen.
   */
  useEffect(() => {
    if (!ready) return

    const open = (text: string) => {
      useSharedText.getState().offer(text)
      /*
       * ⚠️ Not when Add-link is already showing (#600).
       *
       * `offer` above has already done the whole job: the mounted screen
       * re-renders, takes the text and empties the store. A `push` on top of
       * that mounts a *second* Add-link with an empty box, over the filled one
       * — so the user sees their share vanish, and a back-press reveals it.
       *
       * Read through a ref rather than a dependency: `segments` changes on
       * every navigation, and re-running this effect would tear down and
       * re-register the native listener, losing any share that arrived in the
       * gap.
       */
      if (!isOnAddLink(segmentsRef.current)) router.push('/add/link')
    }

    const pending = consumePendingShare()
    if (pending !== null) open(pending)
    return onShare(open)
  }, [ready, router])

  /*
   * ⚠️ **The setup redirect is gone (#613).**
   *
   * It sent anyone with no server to `/setup`, which was right while MiO *was*
   * a client: there was genuinely nothing to show. Since #608 there is no
   * server in the product, so "no server" is the **normal** state and the app
   * opens on the library like any music app.
   *
   * Walling a fresh install behind a demand for a server address would now be
   * asking for something almost nobody has, to reach features that no longer
   * need it. `/setup` still exists and is reachable from Settings, for the
   * self-hoster who wants the one screen that still uses a server (#614).
   */

  return (
    /*
     * Gestures need a root view, and expo-router does not provide one (#233).
     * Without it `GestureDetector` silently never fires on Android — the queue's
     * drag-to-reorder would simply do nothing, with no error to explain why.
     *
     * Outermost, so every screen is inside it rather than only the one that
     * happens to need gestures today.
     */
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {/* Outside the providers on purpose: a crash in the query client or the
          navigator has to be caught too, and a boundary inside them cannot see
          the thing that renders it (#136). */}
        <ErrorBoundary>
          <QueryClientProvider client={queryClient}>
            {ready ? (
              <AppShell />
            ) : (
              // Deliberately bare. This is visible for one storage read, and anything
              // with branding on it would flash.
              <View
                style={[styles.loading, { backgroundColor: theme.background }]}
                testID="startup-gate"
              >
                <ActivityIndicator color={theme.accentOnSurface} />
              </View>
            )}
            {/*
             * Driven by the theme rather than `style="auto"`. `auto` follows the
             * *system* scheme, so forcing light on a dark phone left dark icons on
             * a dark bar — invisible. The app's own answer is the right input.
             */}
            {/* Above everything, and outside the navigator, so a confirmation
                survives the screen that raised it (#379). */}
            <Toast />

            {/* Same placement reasoning as `Toast`: outside the navigator, so
                "there is a newer MiO" is not lost when the screen changes
                (#665). Renders nothing when there is nothing to say. */}
            {ready ? <UpdateBanner /> : null}

            <StatusBar style={theme.isDark ? 'light' : 'dark'} />
          </QueryClientProvider>
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
})

/**
 * The root navigator, with the audio engine mounted beside it.
 *
 * `PlayerHost` sits *outside* `Stack` on purpose — it must not unmount when the
 * route changes, or navigating to the setup screen would stop the music. Since
 * #226 it renders nothing at all: the mini player it used to draw now lives
 * inside the tab navigator, which is the only thing that can position it above
 * the tab bar. The two halves and why they had to separate are documented in
 * `PlayerHost` and `MiniPlayer`.
 *
 * This stack holds only what covers the whole app. Everything reachable from a
 * tab lives under `(tabs)`, so the tab bar and the mini player stay put while
 * you move around inside it.
 */
function AppShell() {
  const { t } = useTranslation()
  const theme = useTheme()
  const showTour = useOnboarding(shouldShowTour)

  return (
    <View style={{ flex: 1, backgroundColor: theme.background }}>
      {/*
       * Titles live here rather than in each screen. `<Stack.Screen>` inside a
       * screen needs a navigator in context, which makes the screen impossible
       * to render on its own in a test — and route config is layout's job
       * anyway. Screens own their content; this owns where they sit.
       */}
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.surface },
          headerTintColor: theme.text,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: theme.background },
        }}
      >
        {/* The tab navigator draws its own headers, one stack per tab. A header
            here as well would stack two bars on top of each other. */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        {/* Both of these deliberately cover the tabs rather than sitting in one.
            The queue *is* the expanded player, so a mini player under it would
            be the same thing twice; setup is the "there is no server yet" state,
            where every tab leads somewhere that cannot load. */}
        <Stack.Screen name="queue" options={{ title: t('queue.title') }} />
        {/* The panel draws its own top bar — a close chevron, "playing from",
            and the 3-dot — so a nav header above it would be a second one
            saying less. It covers the tabs for the same reason the queue does:
            the mini player lives in the tab bar, and a mini player under the
            full player is the same thing twice. */}
        <Stack.Screen name="playing" options={{ headerShown: false }} />
        <Stack.Screen name="setup" options={{ title: t('setup.title') }} />
        {/* Reached from Settings, and covering the tabs like setup does: it is
            a place you go to look at something, not a tab you live in. */}
        <Stack.Screen name="diagnostics" options={{ title: t('diagnostics.title') }} />
      </Stack>
      <PlayerHost />
      {/*
       * The first-run tour (#323).
       *
       * Mounted only while unfinished, so it always opens at step 0 and
       * re-arms cleanly when replayed from Settings — the same trick the web
       * uses, and the reason the overlay needs no reset logic of its own.
       *
       * `hydrated` is the mobile-only half. `persist` reads AsyncStorage
       * asynchronously, so `completed` is `false` for the first frames of every
       * launch; without this gate the tour flashes on every cold start for
       * someone who finished it months ago.
       */}
      {showTour && <OnboardingOverlay />}
    </View>
  )
}

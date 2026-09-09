import { useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import { useQueryClient } from '@tanstack/react-query'

import { useActiveImports } from '../../../src/api/activeImports'
import { useDeviceAdds } from '../../../src/api/deviceAdds'
import { ApiError } from '../../../src/api/client'
import { isSourceRefusal } from '../../../src/library/bilibiliSearch'
import { useCreateJob } from '../../../src/api/jobs'
import { localLibraryKeys, useLibrarySources } from '../../../src/api/localLibrary'
import { useSearch, useSearchUi } from '../../../src/api/search'
import { importToDevice, type DeviceImportProgress } from '../../../src/library/deviceImport'
import { canImportOnDevice } from '../../../src/library/sources'
import { useSearchSource } from '../../../src/library/searchSource'
import { formatDuration } from '../../../src/api/songs'
import type { SearchPlatform, SearchResult } from '../../../src/api/types'
import { useTheme, useThemedStyles, type Theme } from '../../../src/theme'
import { useGuardedRouter } from '../../../src/navigation/useGuardedRouter'
import { Button } from '../../../src/components/ui/Button'
import { Chip } from '../../../src/components/ui/Chip'
import { DeviceAddList } from '../../../src/components/DeviceAddList'
import { SearchSourcePicker } from '../../../src/components/SearchSourcePicker'

/**
 * What search offers.
 *
 * **Bilibili was removed (#240).** It is rate-limited from outside China and
 * refuses roughly half of spaced requests as suspected crawling, so the honest
 * description of it here was "a chip that mostly fails". It stays in
 * add-a-link — a link you already hold is one request, not a search — and the
 * backend still supports it, so this is a decision about what to *offer*, not a
 * capability that was removed.
 *
 * Kept as a list of one rather than deleted: the platform survives in the
 * store, the query key and the API, and a second source should be a line here
 * rather than an unpicking. The chips hide themselves while there is only one.
 */
const PLATFORMS: SearchPlatform[] = ['youtube']

/**
 * Find something to import without knowing its URL.
 *
 * Add-a-link assumes you already have a link. This is for when you only have a
 * song in your head — search, then tap a result to download it.
 *
 * The platform is a row of chips rather than the web client's dropdown — a
 * couple of options do not justify opening a picker on a phone — but there is
 * only YouTube to offer since #240, so the row hides itself.
 *
 * ## Adding says where it has got to
 *
 * A device import runs extract → download → save and can take a minute. It used
 * to be a spinner, and before that the button flipped to "Added" the moment
 * `POST /jobs` returned — which is when the download *starts*. Both were claims
 * the app could not support: one said nothing, the other said something untrue.
 *
 * ## The query outlives this screen (#182)
 *
 * It used to live in component state, under a comment saying TanStack's cache
 * makes going back to a search free. The cache does — but the query string went
 * with the component, so nothing ever asked the cache for it. Leaving the screen
 * and returning gave an empty box, with the results still in memory one key
 * away.
 */
export default function SearchScreen() {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const theme = useTheme()
  const router = useGuardedRouter()
  const input = useSearchUi((state) => state.input)
  const setInput = useSearchUi((state) => state.setInput)
  const query = useSearchUi((state) => state.query)
  const platform = useSearchUi((state) => state.platform)
  const setPlatform = useSearchUi((state) => state.setPlatform)
  const submit = useSearchUi((state) => state.submit)
  // The platform as it was on submit, never the live one (#240): reading
  // `platform` here is what made tapping a chip fire a search nobody asked for.
  const searchedPlatform = useSearchUi((state) => state.searchedPlatform)
  /*
   * The source picker's live value, and the one the last search was run with
   * (#632).
   *
   * They are allowed to disagree — tapping the picker is not a search — and
   * while they do, the results on screen answer a question the user has stopped
   * asking. Derived during render rather than reset in an effect: an effect
   * reacting to a prop is the shape `react-hooks` rejects, and there is nothing
   * to store that these two values do not already say.
   */
  const source = useSearchSource((state) => state.source)
  const searchedSource = useSearchUi((state) => state.searchedSource)
  const history = useSearchUi((state) => state.history)
  const clear = useSearchUi((state) => state.clear)

  /*
   * Which of these results the library already holds (#376).
   *
   * Read once for the whole list rather than per row: it is one cached read of
   * the device library, and asking it forty times would be forty Sets.
   */
  const inLibrary = useLibrarySources()
  const queryClient = useQueryClient()

  /**
   * Try a recorded add again, from the list rather than from a row (#633).
   *
   * The same shape as `add/link.tsx`'s `addOnDevice`: it takes the URL, because
   * the record outlives both the results and the screen — the thing being
   * retried may not be on this page any more, or in this search at all. The
   * record is the memory, not the component.
   */
  const retryAdd = useCallback(
    (url: string) => {
      void (async () => {
        try {
          await importToDevice(url, { source: 'search' })
          await queryClient.invalidateQueries({ queryKey: localLibraryKeys.all })
        } catch {
          // `importToDevice` has already written the failure to the record,
          // which is the thing being looked at. Throwing out of a press handler
          // would only add an unhandled rejection to it.
        }
      })()
    },
    [queryClient],
  )

  /*
   * Leave the screen, forget the query (#319).
   *
   * The store is module-level and nothing ever cleared it, so coming back
   * re-rendered with the same `query` and TanStack served the cached result —
   * which reads as the app searching on its own, and did the same when the
   * platform chip was tapped. Cleared on **blur** rather than focus so the
   * results survive tapping a result and coming back with the back button.
   *
   * The history below is what keeps #182's value — the reason the box used to
   * remember — without the surprise.
   */
  useFocusEffect(useCallback(() => clear, [clear]))

  const { data, isFetching, isError, error } = useSearch(searchedPlatform, searchedSource, query)

  /**
   * The picker has moved since the last search, so nothing on screen answers
   * the current question (#632).
   *
   * *"you switch to bilibili by clicking the button above, the search
   * result carried over to this page… pressed search button but didn't work."*
   * Both halves were the same cause — the source was not in the query key, so
   * re-submitting the same term produced an identical key and TanStack served
   * YouTube's cached answer. The key covers it now; this is the half that keeps
   * the *old* answer from being shown as the new one in the meantime.
   */
  const stale = source !== searchedSource
  const results = stale ? [] : (data ?? [])

  /*
   * A locked feature needs a visible lock, which is the lesson from the web
   * client's ImportGate — a bare failed request is not a UX.
   *
   * **This is dead for YouTube since #353** and deliberately kept. Searching
   * YouTube happens on the device now, reaches no endpoint, and therefore
   * cannot answer 401; the gate on `GET /search` (ADR-009) only still applies
   * to a source the server has to fetch. Removing the branch would mean adding
   * Bilibili search back is a free change, and it is not.
   */
  const locked = isError && error instanceof ApiError && error.status === 401

  if (locked) {
    return (
      <View style={styles.centered}>
        <Text style={styles.lockedTitle}>{t('locked.title')}</Text>
        <Text style={styles.lockedBody}>{t('locked.description')}</Text>
        <Button label={t('library.addKey')} variant="plain" onPress={() => router.push('/setup')} />
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.subtitle}>{t('search.subtitle')}</Text>

        {/* A chooser with one option chooses nothing. Written as a condition
            rather than deleted, so adding a source back is a line in
            PLATFORMS and not an unpicking of this screen. */}
        {PLATFORMS.length > 1 ? (
          <View style={styles.chips}>
            {PLATFORMS.map((name) => (
              <Chip
                key={name}
                label={t(`search.platforms.${name}`)}
                selected={platform === name}
                onPress={() => setPlatform(name)}
              />
            ))}
          </View>
        ) : null}

        {/*
          Past searches, since the box no longer remembers (#319).

          Shown whatever is typed (#376). It used to hide itself the moment a
          character was entered, on the theory that a list of old queries over a
          query being typed is in the way — but the moment you most want
          yesterday's search is while you are halfway through retyping it, which
          is exactly when it disappeared. Tapping one **replaces** the box
          rather than appending to it, which `setInput` already did.
        */}
        {history.length > 0 ? (
          <View style={styles.history}>
            {history.map((past) => (
              <Pressable
                key={past}
                onPress={() => {
                  setInput(past)
                  submit()
                }}
                accessibilityRole="button"
                accessibilityLabel={t('search.repeatAria', { query: past })}
                style={({ pressed }) => [styles.historyChip, pressed && styles.pressed]}
              >
                <Text style={styles.historyText} numberOfLines={1}>
                  {past}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {/* Above the box, because on this screen the source is part of asking
            the question rather than a setting about it — and for a user who
            cannot reach YouTube it is the difference between results and an
            error (#551). */}
        <SearchSourcePicker />

        <View style={styles.searchRow}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder={t('search.placeholder')}
            accessibilityLabel={t('search.title')}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            onSubmitEditing={submit}
          />
          <Pressable
            onPress={submit}
            disabled={isFetching}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.button,
              isFetching && styles.buttonDisabled,
              pressed && styles.pressed,
            ]}
          >
            {isFetching ? (
              <ActivityIndicator color={theme.accentText} />
            ) : (
              <Text style={styles.buttonText}>{t('search.submit')}</Text>
            )}
          </Pressable>
        </View>

        {/*
          What this device has tried to add from here, and how it went (#318,
          #633).

          Mounted on `add/link.tsx` since #318 and **not here**, while
          `importToDevice` has been writing `source: 'search'` records the whole
          time — a list with no reader. So a search add was recorded durably and
          shown nowhere: `ResultRow` kept its phase in `useState`, leaving the
          screen threw it away, and coming back offered "Add" for a track that
          was still downloading. *"it take really long to add, then user
          exit the search page. when them return they will not find the
          downloading progress of that track."*

          `alreadyAdded` does not cover it either — that reads the library, and
          a track still downloading has no library row yet (#309).
        */}
        <DeviceAddList source="search" onRetry={retryAdd} />

        {isError && !stale ? (
          <View accessibilityRole="alert">
            <Text style={styles.error}>
              {/* Bilibili refuses a burst of requests as suspected crawling.
                  Common enough to deserve its own wording, in the user's
                  language, rather than the extractor's English.

                  ⚠️ The `ApiError` half is the **server** path and has not been
                  the one that fires since #353 moved searching to the phone. A
                  device-side refusal is a `SearchRefused` and was falling
                  through to `error.message` — so the string existed, was
                  translated, and showed the raw English "Bilibili search
                  refused: HTTP 412" instead (#586). */}
              {(error instanceof ApiError && error.status === 503) || isSourceRefusal(error)
                ? t('search.rateLimited')
                : error.message}
            </Text>
          </View>
        ) : null}
      </View>

      <FlatList
        data={results}
        keyExtractor={(result) => result.url}
        // `extraData`, because what a row shows now depends on something outside
        // `data`: the device library. Without it a row drawn before an import
        // finished would keep saying "Add".
        extraData={inLibrary}
        renderItem={({ item }) => (
          <ResultRow result={item} alreadyAdded={inLibrary.has(item.url)} />
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          query && data && !isFetching && !stale ? (
            <View style={styles.centered}>
              <Text style={styles.emptyTitle}>{t('search.noResults')}</Text>
            </View>
          ) : null
        }
        keyboardShouldPersistTaps="handled"
      />
    </View>
  )
}

/**
 * One result, and whether anything need be done about it.
 *
 * `alreadyAdded` comes from the device library rather than from this row's own
 * memory (#376). The row's `state` only ever knew about an import *it* started,
 * so searching the same term twice — or leaving the screen and coming back, or
 * restarting the app — offered "Add" for a song already on the phone.
 */
function ResultRow({ result, alreadyAdded }: { result: SearchResult; alreadyAdded: boolean }) {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const theme = useTheme()
  const createJob = useCreateJob()
  const track = useActiveImports((state) => state.track)
  const queryClient = useQueryClient()
  /**
   * This row's durable record, if it has one (#633).
   *
   * `state` below only ever knew about an import *this component* started, so
   * a remount — leaving the screen, searching again, restarting the app —
   * offered "Add" for a download that was still running, and pressing it would
   * have started a second one over the same file. The record survives all
   * three, and `markInterrupted` already turns a stale `working` into a failure
   * at launch, so this cannot latch.
   */
  const record = useDeviceAdds((state) => state.adds.find((add) => add.url === result.url) ?? null)
  const [state, setState] = useState<'idle' | 'working' | 'queued' | 'added'>('idle')
  const [failed, setFailed] = useState<string | null>(null)
  /** Which phase the device import is in (#240), or null when it is not running. */
  const [progress, setProgress] = useState<DeviceImportProgress | null>(null)

  const meta = [result.uploader, result.duration ? formatDuration(result.duration) : null]
    .filter(Boolean)
    .join(' · ')

  /**
   * Adding from search fetches on **this device** (#246).
   *
   * It used to create a server job like add-a-link's first button, which meant
   * it inherited the measured 1-in-14: the droplet is refused by YouTube on
   * every client. The phone is not, because the request comes from a
   * residential address.
   *
   * The server path stays for everything the device cannot fetch — Bilibili,
   * and anything else yt-dlp supports — so this is a choice per result rather
   * than a replacement. Tracking the job is still what hands *those* over
   * (#215): the progress panel watches `useActiveImports`, and the handover
   * runs when a watched job goes `done`.
   */
  const add = useCallback(() => {
    setFailed(null)

    if (!canImportOnDevice(result.url)) {
      createJob.mutate(result.url, {
        onSuccess: (created) => {
          track(created.id, result.url)
          // "Queued", not "Added" (#240). `POST /jobs` returning is the moment
          // the download *starts*; saying "Added" there claims a song is in the
          // library while the server has not fetched a byte of it. The progress
          // strip watches the tracked job and the handover runs when it is
          // genuinely done.
          setState('queued')
        },
      })
      return
    }

    setState('working')
    setProgress({ phase: 'extracting', attempt: 1, client: null })
    void (async () => {
      try {
        await importToDevice(result.url, { onProgress: setProgress, source: 'search' })
        // The library reads the device, so it shows the old rows until told to
        // look again — the omission that made a successful import look like a
        // failure in #216.
        await queryClient.invalidateQueries({ queryKey: localLibraryKeys.all })
        // "Added" is only said here, after the audio is on the disk — which is
        // what makes the word true (#240).
        setState('added')
      } catch (error) {
        // Shown, not swallowed: a search result that silently does nothing is
        // indistinguishable from a broken button.
        setFailed(error instanceof Error ? error.message : String(error))
        setState('idle')
      } finally {
        setProgress(null)
      }
    })()
  }, [createJob, queryClient, result.url, track])

  const busy = state === 'working' || createJob.isPending || record?.status === 'working'
  // The library counts as done even though this row did nothing — that is the
  // whole of #376. It also *un*-counts when the song is deleted, which a
  // remembered flag could not do.
  const added = state === 'added' || alreadyAdded
  const done = added || state === 'queued'

  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.title} numberOfLines={2}>
          {result.title}
        </Text>
        {meta ? (
          <Text style={styles.meta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
        {/* Where the import has got to, in words. A spinner says "something is
            happening" and nothing else — and this can take a minute, during
            which "something" is indistinguishable from "stuck" (#240). */}
        {progress ? (
          <Text style={styles.progress} numberOfLines={1} accessibilityLiveRegion="polite">
            {/* The attempt is a suffix, not a replacement. Written the other
                way round it swallowed the phase: once a client had been
                retired, every later phase read "Retrying" and the import
                looked stuck at the moment it started working. */}
            {t(`search.progress.${progress.phase}`)}
            {progress.attempt > 1
              ? ` · ${t('search.progress.attempt', { attempt: progress.attempt })}`
              : ''}
          </Text>
        ) : null}
        {failed ? (
          <Text style={styles.rowError} numberOfLines={2} accessibilityRole="alert">
            {failed}
          </Text>
        ) : null}
      </View>
      <Pressable
        onPress={add}
        disabled={done || busy}
        accessibilityRole="button"
        accessibilityLabel={t('search.add')}
        style={({ pressed }) => [
          styles.addButton,
          (done || busy) && styles.buttonDisabled,
          pressed && styles.pressed,
        ]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={theme.accentOnSurface} />
        ) : (
          <Text style={styles.addText}>
            {added
              ? t('search.addedShort')
              : state === 'queued'
                ? t('search.queuedShort')
                : t('search.add')}
          </Text>
        )}
      </Pressable>
    </View>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    /** The one shared press fill (#378). */
    pressed: { backgroundColor: theme.surfacePressed },
    container: { flex: 1, backgroundColor: theme.background },
    header: { paddingHorizontal: 16, paddingTop: 12, gap: 10 },
    subtitle: { fontSize: 13, color: theme.textMuted, lineHeight: 18 },
    chips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
    history: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    historyChip: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 999,
      backgroundColor: theme.surfaceMuted,
      maxWidth: '100%',
    },
    historyText: { fontSize: 13, color: theme.textMuted },
    searchRow: { flexDirection: 'row', gap: 8 },
    input: {
      flex: 1,
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 15,
      color: theme.text,
    },
    button: {
      backgroundColor: theme.accentSolid,
      borderRadius: 8,
      paddingHorizontal: 16,
      justifyContent: 'center',
      minWidth: 76,
      alignItems: 'center',
    },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: theme.accentText, fontSize: 15, fontWeight: '600' },
    error: { color: theme.danger, fontSize: 13 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      gap: 12,
    },
    rowText: { flex: 1, minWidth: 0 },
    title: { fontSize: 15, fontWeight: '500', color: theme.text },
    meta: { fontSize: 12, color: theme.textMuted, marginTop: 3 },
    progress: { fontSize: 12, color: theme.accentOnSurface, marginTop: 4 },
    rowError: { fontSize: 12, color: theme.danger, marginTop: 4 },
    addButton: {
      borderWidth: 1,
      borderColor: theme.accentSolid,
      borderRadius: 999,
      paddingHorizontal: 14,
      paddingVertical: 7,
      minWidth: 64,
      alignItems: 'center',
    },
    addText: { color: theme.accentOnSurface, fontSize: 13, fontWeight: '600' },
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: theme.border,
      marginLeft: 16,
    },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 },
    emptyTitle: { fontSize: 15, fontWeight: '500', color: theme.text },
    lockedTitle: { fontSize: 18, fontWeight: '600', color: theme.text },
    lockedBody: { fontSize: 14, color: theme.textMuted, textAlign: 'center', lineHeight: 20 },
  })

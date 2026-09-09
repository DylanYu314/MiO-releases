import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native'

import {
  useBulkUpdateMatches,
  useImportMatches,
  useUpdateMatch,
  type MatchStatusFilter,
} from '../api/playlistImports'
import { useFinishedImports, useSourcesWithAudio } from '../api/deviceImportState'
import { useTrackStates, type TrackPhase, type TrackState } from '../api/trackStates'
import type { FailureKind } from '../library/failureKind'
import { sourceLabelKey } from '../library/sources'

import { formatDuration } from '../api/songs'
import type {
  LocalMatchCandidate as MatchCandidate,
  LocalTrackMatch as TrackMatch,
} from '../library/playlistImports'
import { useTheme, useThemedStyles, type Theme } from '../theme'
import { ActionSheet, type SheetAction } from './ActionSheet'
import { showToast } from './Toast'
import { NamePrompt } from './NamePrompt'
import { Chip } from '../components/ui/Chip'
import { Button } from '../components/ui/Button'

/** A stable empty map: a fresh `{}` per render would make every row re-render
 *  on every tick of an import that has nothing to do with it. */
const EMPTY_STATES: Record<string, TrackState> = {}

/** While reviewing, "what still needs me?" is the question. */
const REVIEW_FILTERS: MatchStatusFilter[] = ['all', 'needs_review', 'no_match', 'auto_matched']

/** Once the downloads have run, "did it work?" is. */
const RESULT_FILTERS: MatchStatusFilter[] = ['all', 'imported', 'failed', 'no_match']

interface Props {
  importId: string
  /** True in the `review` stage, where rows can be accepted, rejected and
   *  repointed. False afterwards, where the list is a record. */
  interactive?: boolean
}

/**
 * The match review (#203) — the part of a Spotify import that needs a human.
 *
 * Spotify hands over a *track list*, not audio, so every track has to be found
 * on YouTube first. The matcher scores what it finds and sorts the result into
 * three piles: confident enough to keep (`auto_matched`), plausible but worth
 * asking about (`needs_review`), and nothing found (`no_match`). This is where
 * the second and third get answered.
 *
 * ## Why the phone does not copy the web's table
 *
 * The web has a checkbox column, a select-all, offset pagination and a
 * bulk-action bar over the selection. On a phone that is a lot of chrome around
 * rows that are already two lines tall, and multi-select plus paging is two
 * modes to be in at once.
 *
 * So: infinite scroll instead of pages, per-row accept/reject under the thumb,
 * and **bulk actions that apply to the filter you are looking at** rather than
 * to a selection you have built. That is the operation people actually want —
 * "reject everything with no match" — expressed in one tap instead of forty,
 * and the filter chips make the scope of the button visible before it is
 * pressed.
 *
 * The bulk action deliberately applies only to the rows **already loaded**, and
 * says how many. Acting on rows the user has not scrolled to would be a button
 * whose effect depends on how far down the list they happen to be, which is a
 * worse surprise than having to scroll.
 */
export function MatchReview({ importId, interactive = false }: Props) {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const theme = useTheme()

  const [filter, setFilter] = useState<MatchStatusFilter>('all')
  /** The row whose candidate sheet is open, or null. */
  const [choosing, setChoosing] = useState<TrackMatch | null>(null)
  /** True while the "paste a link" prompt is up, for the row in `choosing`. */
  const [pasting, setPasting] = useState(false)

  /*
   * In result mode the **server** cannot answer the filter (#308).
   *
   * `imported` and `failed` are `TrackMatchStatus` values the server sets when
   * *it* downloads, and it has not downloaded anything since confirm began
   * sending `download: false` (#270). So both lists were always empty however
   * well the import went — which is what I saw. The device holds the
   * answer, so the rows are fetched unfiltered and sorted out here.
   */
  const serverFilter: MatchStatusFilter = interactive ? filter : 'all'
  const { data, isPending, isError, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useImportMatches(importId, serverFilter)
  const updateMatch = useUpdateMatch(importId)
  const bulkUpdate = useBulkUpdateMatches(importId)

  const filters = interactive ? REVIEW_FILTERS : RESULT_FILTERS
  const loaded = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data])

  const sourceUrls = useMemo(
    () => loaded.map((match) => match.chosen_url).filter((url): url is string => url !== null),
    [loaded],
  )
  const { data: onDevice } = useSourcesWithAudio(sourceUrls)
  /** Live per-track state for this run, empty when nothing is going (#452). */
  const liveStates = useTrackStates((state) => state.runs[importId] ?? EMPTY_STATES)
  /** What the last run left behind, for after a restart — the store dies with
   *  the JS context and "which four failed" is asked on coming back. */
  const { data: finishedRecords } = useFinishedImports()
  const remembered = finishedRecords?.[importId]

  const matches = useMemo(() => {
    if (interactive || filter === 'all') return loaded
    return loaded.filter((match) => {
      // "No match" is still the server's to say: nothing was ever chosen, so
      // there is nothing the device could hold.
      if (filter === 'no_match') return match.status === 'no_match'
      const here = match.chosen_url !== null && (onDevice?.has(match.chosen_url) ?? false)
      if (filter === 'imported') return here
      // Failed means "we meant to fetch this and it is not here" — a track with
      // no candidate at all belongs in its own list, not this one.
      if (filter === 'failed') return !here && match.status !== 'no_match'
      return true
    })
  }, [loaded, interactive, filter, onDevice])

  const runBulk = (status: 'accepted' | 'rejected') =>
    bulkUpdate.mutate({ matchIds: matches.map((match) => match.id), status })

  const choose = (match: TrackMatch, url: string) => {
    setChoosing(null)
    // A repoint is also an acceptance. Choosing a track and then having to say
    // "yes, that one" is a second tap for a decision already made.
    updateMatch.mutate({ matchId: match.id, chosenUrl: url, status: 'accepted' })
    // After the import has run, changing the source is only half the job — the
    // fetch has already happened and will not happen again on its own (#399).
    // The retry button is on the screen around this one, so this says where to
    // go rather than leaving a repoint that appears to do nothing.
    if (!interactive) showToast(t('matchReview.repointedToast'))
  }

  /**
   * Whether a finished row can still be pointed somewhere else (#399).
   *
   * *"i want to change the source to try if it work, but there are no
   * option for you to change source for failed track"*. The review stage has had
   * exactly this affordance since #203 and it disappeared the moment the import
   * ran — on precisely the rows where a human has something useful to add.
   *
   * The issue's premise was that the candidates survive, and it asked for that
   * to be verified rather than assumed: they do. `TrackMatch.candidates` comes
   * down with every row in both modes, which is why this needs no new machinery
   * — it is the same sheet, opened from the other stage.
   *
   * Offered for a track the **device does not hold**, which is what this screen
   * already means by "failed" (#308), and for `no_match` too — the track the
   * matcher found nothing for is the one a pasted URL helps most.
   */
  const canRepoint = (match: TrackMatch): boolean => {
    if (interactive) return false
    return !(match.chosen_url !== null && (onDevice?.has(match.chosen_url) ?? false))
  }

  return (
    <View style={styles.section}>
      <View style={styles.filters}>
        {filters.map((value) => (
          <Chip
            key={value}
            label={t(`matchFilter.${value}`)}
            selected={filter === value}
            onPress={() => setFilter(value)}
          />
        ))}
      </View>

      {/* Scoped to what is loaded and filtered, and it says so — see the
          docblock. Hidden with nothing to act on, so it cannot be a button that
          does nothing. */}
      {interactive && matches.length > 0 ? (
        <View style={styles.bulkRow}>
          {/* Outlined, not plain text (#377, UI 4): these two act on every row
              on screen at once, which is the last thing that should look like a
              caption. They also say when they are working, rather than going
              quiet mid-request. */}
          <Button
            label={t('matchReview.acceptAll', { count: matches.length })}
            variant="outlined"
            style={styles.bulkButton}
            onPress={() => runBulk('accepted')}
            busy={bulkUpdate.isPending}
          />
          <Button
            label={t('matchReview.rejectAll', { count: matches.length })}
            variant="outlined"
            style={styles.bulkButton}
            onPress={() => runBulk('rejected')}
            busy={bulkUpdate.isPending}
          />
        </View>
      ) : null}

      {isPending ? (
        <View style={styles.centered}>
          <ActivityIndicator />
          <Text style={styles.hint}>{t('matchReview.loading')}</Text>
        </View>
      ) : null}

      {isError ? (
        <View accessibilityRole="alert">
          <Text style={styles.error}>{t('matchReview.loadError', { message: error.message })}</Text>
        </View>
      ) : null}

      {updateMatch.isError ? (
        <View accessibilityRole="alert">
          <Text style={styles.error}>{updateMatch.error.message}</Text>
        </View>
      ) : null}

      <FlatList
        data={matches}
        keyExtractor={(match) => String(match.id)}
        scrollEnabled={false}
        renderItem={({ item }) => (
          <MatchRow
            match={item}
            interactive={interactive}
            repointable={canRepoint(item)}
            rowState={rowStateFor(
              item.chosen_url,
              liveStates,
              remembered?.failures,
              item.chosen_url !== null && (onDevice?.has(item.chosen_url) ?? false),
            )}
            onAccept={() => updateMatch.mutate({ matchId: item.id, status: 'accepted' })}
            onReject={() => updateMatch.mutate({ matchId: item.id, status: 'rejected' })}
            onChoose={() => setChoosing(item)}
          />
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          isPending ? null : <Text style={styles.hint}>{t('matchReview.nothingHere')}</Text>
        }
        ListFooterComponent={
          hasNextPage ? (
            <Pressable
              onPress={() => fetchNextPage()}
              disabled={isFetchingNextPage}
              accessibilityRole="button"
              style={({ pressed }) => [styles.more, pressed && styles.pressed]}
            >
              {isFetchingNextPage ? (
                <ActivityIndicator size="small" color={theme.accentOnSurface} />
              ) : (
                <Text style={styles.link}>{t('matchReview.loadMore')}</Text>
              )}
            </Pressable>
          ) : null
        }
      />

      {/* One sheet for whichever row asked, rather than one per row: forty rows
          would otherwise each hold a Modal. */}
      <ActionSheet
        visible={choosing !== null && !pasting}
        title={choosing ? `${choosing.title} — ${choosing.artist}` : ''}
        subtitle={t('matchReview.change')}
        actions={choosing ? candidateActions(choosing) : []}
        onClose={() => setChoosing(null)}
      />

      {pasting && choosing ? (
        <NamePrompt
          title={t('matchReview.customUrl')}
          confirmLabel={t('common.save')}
          onConfirm={(url) => {
            setPasting(false)
            const match = choosing
            if (url.trim()) choose(match, url.trim())
            else setChoosing(null)
          }}
          onClose={() => {
            setPasting(false)
            setChoosing(null)
          }}
        />
      ) : null}
    </View>
  )

  function candidateActions(match: TrackMatch): SheetAction[] {
    const actions: SheetAction[] = match.candidates.map((candidate, index) => ({
      key: `${candidate.url}-${index}`,
      label: candidateLabel(candidate, match.chosen_url === candidate.url),
      // Picking between two videos with the same title is exactly when a
      // picture decides it (#312).
      thumbnail: candidate.thumbnail ?? null,
      onPress: () => choose(match, candidate.url),
    }))

    // Always offered, including for `no_match` — a track the matcher found
    // nothing for is exactly the one a human can fix, and with no candidates
    // this would otherwise be an empty sheet.
    actions.push({
      key: 'paste',
      label: t('matchReview.customUrlAction'),
      replacesSheet: true,
      onPress: () => setPasting(true),
    })

    return actions
  }

  function candidateLabel(candidate: MatchCandidate, chosen: boolean): string {
    const parts = [
      candidate.uploader,
      candidate.duration ? formatDuration(candidate.duration) : null,
    ]
    // The score is the machine's opinion and is shown as one — a percentage
    // next to a title, not a bare number pretending to be a rank.
    if (candidate.score !== null) {
      parts.push(t('matchReview.score', { percent: Math.round(candidate.score * 100) }))
    }
    const meta = parts.filter(Boolean).join(' · ')
    return `${chosen ? '✓ ' : ''}${candidate.title}${meta ? `\n${meta}` : ''}`
  }
}

/**
 * One track: what Spotify said, what the matcher found, and what to do.
 *
 * Not memoized, unlike `SongRow`. The list is bounded by a playlist and drawn
 * inside a `ScrollView` rather than virtualized, and every handler here closes
 * over the row's own id — a memo would buy nothing and cost the indirection.
 */
/**
 * What a row should say about itself, beyond its title (#452).
 *
 * Live state wins over the persisted record: during a run the store knows this
 * track is `downloading`, and the record still describes the *previous* run.
 * Once the run is over the store is the same answer, and after a restart it is
 * gone and only the record is left — which is the case this exists for, since
 * "which four tracks failed and why" is what somebody asks on coming back.
 *
 * `null` for a track that is simply on the device: the list already means that.
 */
export function rowStateFor(
  url: string | null,
  live: Record<string, TrackState>,
  remembered: Record<string, FailureKind> | undefined,
  onDevice: boolean,
): { phase: TrackPhase; failure: FailureKind | null; detail?: string | null } | null {
  if (url === null) return null
  const current = live[url]
  if (current) return { phase: current.phase, failure: current.failure, detail: current.detail }
  const failure = remembered?.[url]
  if (failure) return { phase: 'failed', failure }
  // Nothing recorded either way. On the device it needs no explanation; not on
  // the device, and it failed in a run nobody kept a record of.
  return onDevice ? null : { phase: 'failed', failure: null }
}

function MatchRow({
  match,
  interactive,
  repointable,
  rowState,
  onAccept,
  onReject,
  onChoose,
}: {
  match: TrackMatch
  interactive: boolean
  /** What this track is doing, or what became of it. Null when the list itself
   *  already says it (#452). */
  rowState: { phase: TrackPhase; failure: FailureKind | null; detail?: string | null } | null
  /** Result mode, and this row can still be sent somewhere else (#399). It buys
   *  the press and the hint, and nothing else — the accept/reject checkbox
   *  belongs to the review, where the decision is what to download at all. */
  repointable: boolean
  onAccept: () => void
  onReject: () => void
  onChoose: () => void
}) {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)

  const chosen = match.candidates.find((candidate) => candidate.url === match.chosen_url)
  /* The picture of what would actually be downloaded, not of the Spotify track
     — the row is asking "is this the right video?" (#312). Falls back to the
     first candidate so a row still shows something before a choice is made. */
  const thumbnail = chosen?.thumbnail ?? match.candidates[0]?.thumbnail ?? null

  /** Whether this track will be imported — the one state the row is about. */
  const included =
    match.status === 'accepted' || match.status === 'auto_matched' || match.status === 'imported'
  /** A track with no URL has nothing to include. */
  const canInclude = match.chosen_url !== null
  /** Whether pressing the row opens the candidate sheet — during the review, or
   *  afterwards on a track the device never got (#399). */
  const choosable = interactive || repointable

  return (
    // Dimmed when it will not be imported (#377), so the shape of the selection
    // is readable at a glance rather than one status word at a time.
    <View style={[styles.row, interactive && !included && styles.rowExcluded]}>
      {thumbnail ? (
        <Image
          testID={`match-thumbnail-${match.id}`}
          source={{ uri: thumbnail }}
          style={styles.thumbnail}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
      ) : (
        <View testID={`match-thumbnail-empty-${match.id}`} style={styles.thumbnailEmpty} />
      )}
      <Pressable
        onPress={choosable ? onChoose : undefined}
        disabled={!choosable}
        accessibilityRole={choosable ? 'button' : undefined}
        accessibilityLabel={
          choosable ? t('matchReview.chooseAria', { title: match.title }) : undefined
        }
        style={({ pressed }) => [styles.rowText, pressed && styles.pressed]}
      >
        <Text style={styles.rowTitle} numberOfLines={1}>
          {match.title}
        </Text>
        <Text style={styles.rowArtist} numberOfLines={1}>
          {match.artist}
        </Text>
        {/* What would actually be downloaded. A review screen that shows only
            the Spotify track is asking the user to approve something they
            cannot see. */}
        {chosen ? (
          <Text style={styles.rowMatch} numberOfLines={1}>
            {t('matchReview.matchedTo', { title: chosen.title })}
          </Text>
        ) : match.chosen_url ? (
          // Repointed by hand: there is no candidate to name, and the URL is
          // the honest thing to show.
          <Text style={styles.rowMatch} numberOfLines={1}>
            {t('matchReview.matchedTo', { title: match.chosen_url })}
          </Text>
        ) : (
          <Text style={styles.rowNoMatch}>{t('matchReview.noCandidate')}</Text>
        )}
        {match.error ? (
          <Text style={styles.rowError} numberOfLines={2}>
            {match.error}
          </Text>
        ) : null}
        {/*
          Says the row can be re-matched (#377, UI 9).

          *"I see we can click a track to see other resource and change
          link… but user wont know, there is no indication or hint"* — and I
          named it as the app-wide problem, not a local one. A whole row that is
          pressable and looks exactly like a row that is not is invisible
          affordance; the only way to find it was to press everything.

          A word rather than a chevron, because what the press does is not
          "open" — it offers the other candidates the matcher found.
        */}
        {choosable ? (
          <Text style={styles.rowChange}>
            {t(repointable ? 'matchReview.tryAnother' : 'matchReview.change')} ›
          </Text>
        ) : null}
      </Pressable>

      <View style={styles.rowSide}>
        {/*
          In result mode the **server's** status is not the interesting one
          (#452).
          *
          * `matchStatus.accepted` is what the user decided before the download
          * ran; it says nothing about whether the audio arrived. So a finished
          * import shows what this device did with the track — and when that was
          * a failure, why.
        */}
        {!interactive && rowState ? (
          <Text
            style={[
              styles.status,
              rowState.phase === 'failed' ? styles.statusBad : styles.statusNeutral,
            ]}
          >
            {t(`trackPhase.${rowState.phase}`)}
          </Text>
        ) : (
          <Text style={[styles.status, statusStyle(match.status, styles)]}>
            {t(`matchStatus.${match.status}`)}
          </Text>
        )}
        {!interactive && rowState?.failure ? (
          <View style={styles.reasonBlock}>
            {/* The reason, in the user's language — "Ran out of time … worth
                trying again" rather than "Download was short: 10764208 of …".

                `source` names the service **this row** came from (#565). It
                used to be the word "YouTube", baked into the string, so a
                Bilibili match that Bilibili itself refused was reported as
                YouTube's doing — to the user of the one feature that exists
                because they cannot reach YouTube at all. Only `unavailable`
                interpolates it; the other kinds already say "The source", and
                i18next ignores an unused variable, so every kind can be given
                it without a branch. */}
            <Text style={styles.reason}>
              {t(`failureKind.${rowState.failure}`, {
                source: t(sourceLabelKey(match.chosen_url ?? '')),
              })}
            </Text>
            {/* And how, in the thrower's own words (#582). Without it every
                failed row of an eighteen-track import reads identically —
                which is what I saw, and why that run could not be
                diagnosed from the screen it happened on. */}
            {rowState.detail ? (
              <Text style={styles.technical} numberOfLines={2}>
                {rowState.detail}
              </Text>
            ) : null}
          </View>
        ) : null}
        {interactive ? (
          /*
           * One check box, not a tick and a cross (#377, UI 3).
           *
           * the green tick and red cross "reads as two actions when it is
           * really one state". They were: accept and reject are the two values
           * of *will this be imported*, and a pair of buttons made the reader
           * work that out from two icons and a status word. A box that is either
           * ticked or not says it once, and its unticked row is dimmed so the
           * selection is legible down the whole list without reading anything.
           */
          <Pressable
            onPress={included ? onReject : onAccept}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: included, disabled: !canInclude }}
            accessibilityLabel={t('matchReview.includeAria', { title: match.title })}
            hitSlop={8}
            // Nothing to include: accepting a track with no URL would enqueue a
            // download of nothing. Already-rejected rows can still be re-ticked.
            disabled={!canInclude}
            style={({ pressed }) => [
              styles.checkbox,
              included && styles.checkboxOn,
              !canInclude && styles.actionDisabled,
              pressed && styles.pressed,
            ]}
          >
            {included ? <Text style={styles.checkboxTick}>{'✓'}</Text> : null}
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}

function statusStyle(status: TrackMatch['status'], styles: ReturnType<typeof makeStyles>) {
  if (status === 'accepted' || status === 'auto_matched' || status === 'imported') {
    return styles.statusGood
  }
  if (status === 'no_match' || status === 'failed' || status === 'rejected') {
    return styles.statusBad
  }
  return styles.statusNeutral
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    /** The one shared press fill (#378). */
    pressed: { backgroundColor: theme.surfacePressed },
    section: { gap: 10, marginTop: 8 },
    filters: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
    bulkRow: { flexDirection: 'row', gap: 18, flexWrap: 'wrap' },
    bulkText: { fontSize: 14, color: theme.accentOnSurface },
    destructive: { color: theme.danger },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
    // Under the phase, and narrow: it is an explanation, not a heading.
    reasonBlock: { maxWidth: 140, alignItems: 'flex-end' },
    reason: { fontSize: 11, color: theme.textMuted, textAlign: 'right' },
    /** Quieter still: this line is for whoever is debugging and must not
     *  compete with the sentence above it that says what to do (#582). */
    technical: { fontSize: 10, color: theme.textMuted, opacity: 0.7, textAlign: 'right' },
    // Square and small: this is an identity check, not artwork. A 16:9 frame
    // would make the rows taller for no more information.
    thumbnail: { width: 44, height: 44, borderRadius: 6, backgroundColor: theme.surfaceMuted },
    thumbnailEmpty: {
      width: 44,
      height: 44,
      borderRadius: 6,
      backgroundColor: theme.surfaceMuted,
    },
    rowText: { flex: 1, minWidth: 0 },
    rowTitle: { fontSize: 15, fontWeight: '500', color: theme.text },
    rowArtist: { fontSize: 13, color: theme.textMuted, marginTop: 1 },
    rowMatch: { fontSize: 12, color: theme.accentOnSurface, marginTop: 3 },
    rowNoMatch: { fontSize: 12, color: theme.warning, marginTop: 3 },
    rowError: { fontSize: 12, color: theme.danger, marginTop: 3 },
    rowSide: { alignItems: 'flex-end', gap: 6 },
    status: { fontSize: 11, fontWeight: '600' },
    statusGood: { color: theme.accentOnSurface },
    statusBad: { color: theme.danger },
    statusNeutral: { color: theme.textMuted },
    rowActions: { flexDirection: 'row', gap: 4 },
    actionDisabled: { opacity: 0.3 },
    checkbox: {
      width: 28,
      height: 28,
      borderRadius: 6,
      borderWidth: 2,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkboxOn: { backgroundColor: theme.accentSolid, borderColor: theme.accentSolid },
    checkboxTick: { fontSize: 16, fontWeight: '700', color: theme.accentText },
    // Dimmed rather than hidden: an excluded track is still a track the user
    // may want to look at and put back.
    rowExcluded: { opacity: 0.55 },
    rowChange: { fontSize: 12, color: theme.accentOnSurface, marginTop: 4 },
    bulkButton: { flex: 1 },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: theme.border },
    more: { paddingVertical: 12, alignItems: 'center' },
    link: { fontSize: 14, color: theme.accentOnSurface },
    centered: { alignItems: 'center', gap: 6, paddingVertical: 16 },
    hint: { fontSize: 13, color: theme.textMuted, paddingVertical: 8 },
    error: { fontSize: 13, color: theme.danger },
  })

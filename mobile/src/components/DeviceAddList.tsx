import { useTranslation } from 'react-i18next'
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native'

import { useDeviceAdds, type DeviceAdd, type DeviceAddSource } from '../api/deviceAdds'
import { sourceLabelKey } from '../library/sources'
import { useThemedStyles, type Theme } from '../theme'
import { Button } from '../components/ui/Button'

interface Props {
  /** Only this page's adds. The search page and the add-link page each show
   *  their own, because "what did I add here" is the question being asked. */
  source: DeviceAddSource
  /** Try a failed one again. */
  onRetry?: (url: string) => void
}

/**
 * What this device has tried to add, and how it went (#318).
 *
 * *"if the user adds the link and quits before the track is downloaded…
 * when they come back they need to see what was added successfully, what
 * failed, and what was interrupted — with the track's link, title, artist and
 * thumbnail."*
 *
 * The record is `useDeviceAdds`, which the import path writes rather than any
 * screen, so this draws the truth even for a run whose screen never mounted
 * again. **Interrupted is a failure with a particular reason** — the app was
 * killed mid-download — and it reads differently because the answer differs:
 * nothing was wrong with the link, it simply never finished.
 */
/**
 * The raw failure, when there is one worth showing (#582).
 *
 * `null` unless this record both **failed** and carries a message the kind does
 * not already say.
 *
 * ## ⚠️ It used to name the exceptions, and they rotted (#653)
 *
 * This docblock claimed two exclusions — a record with no kind, and
 * `VideoUnavailable`, whose message `messageFor` translates into the very
 * sentence the main line shows. The first was enforced. **The second never
 * was**: the body returned `add.error` whenever a kind existed, so a
 * region-locked video has always printed its reason twice. Nobody noticed
 * because it is rare.
 *
 * #639 then added a second translated case, `refused_at_start`, which is
 * common — and I saw it immediately, on my own failing add:
 *
 *     YouTube 在开始传输前就拒绝了下载。目前每次都会自行恢复，请过几分钟再试。
 *     YouTube 在开始传输前就拒绝了下载。目前每次都会自行恢复，请过几分钟再试。
 *
 * So the rule is stated as a **comparison** rather than a list of cases. A list
 * has to be extended every time `messageFor` learns a new sentence, and the
 * evidence is that it will not be.
 *
 * `shown` is what the row is already displaying, passed in rather than rebuilt
 * here: rebuilding it would mean this function and the row could disagree about
 * what "the same" means, which is the fault being fixed.
 *
 * Exported so the decision can be tested without rendering, in the way
 * `detailKeyFor` and `phaseKeyFor` already are.
 */
export function technicalDetail(add: DeviceAdd, shown: string): string | null {
  if (add.status !== 'failed' || !add.failure || !add.error) return null
  return add.error.trim() === shown.trim() ? null : add.error
}

export function DeviceAddList({ source, onRetry }: Props) {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const adds = useDeviceAdds((state) => state.adds)
  const forget = useDeviceAdds((state) => state.forget)
  const clearFinished = useDeviceAdds((state) => state.clearFinished)

  const mine = adds.filter((add) => add.source === source)

  const detailFor = (add: DeviceAdd): string => {
    const key = detailKeyFor(add)
    // A finished song says who it is by; the artist is more use than "on this
    // device", which the list already implies.
    if (key === 'done') return add.artist ?? t('deviceAdds.done')
    if (key === 'failed') {
      /*
       * The **kind** first, and the raw message only as a fallback (#441).
       *
       * `add.error` is written for whoever is debugging — "Download refused
       * with status 403 at byte 0" — and the one thing a user wants from it is
       * whether trying again could work. The kind says that; the string does
       * not. Older records have no kind, and they keep their message.
       */
      // `source` names the service **this row** was fetched from (#565). The
      // `unavailable` string used to say "YouTube" whatever the link was, so a
      // Bilibili video that Bilibili had removed came back as YouTube's
      // refusal. Every kind is given the variable because i18next ignores an
      // unused one, which keeps this a lookup rather than a branch.
      if (add.failure) {
        return t(`failureKind.${add.failure}`, { source: t(sourceLabelKey(add.url)) })
      }
      return add.error ?? t('deviceAdds.failed')
    }
    if (key !== 'working') return t(`deviceAdds.${key}`)

    // A working row says which step it is on, and — once it has retried — which
    // attempt. Without those a twenty-minute walk through four clients and a
    // genuinely stuck download are the same spinner (#430).
    const phase = t(`deviceAdds.${phaseKeyFor(add)}`)
    return showsAttempt(add)
      ? `${phase} · ${t('deviceAdds.attempt', { n: add.attempt, total: add.attempts })}`
      : phase
  }

  if (mine.length === 0) return null

  return (
    <View style={styles.block}>
      <View style={styles.header}>
        <Text style={styles.heading}>{t('deviceAdds.heading')}</Text>
        {mine.some((add) => add.status !== 'working') ? (
          <Button label={t('deviceAdds.clear')} variant="plain" onPress={clearFinished} />
        ) : null}
      </View>

      {mine.map((add) => {
        // Computed once and passed down, so the row and `technicalDetail` cannot
        // disagree about what the main line says (#653).
        const shown = detailFor(add)
        const technical = technicalDetail(add, shown)
        return (
          <View key={add.url} style={styles.row} testID={`device-add-${add.url}`}>
            {add.thumbnail ? (
              <Image
                source={{ uri: add.thumbnail }}
                style={styles.thumbnail}
                accessibilityElementsHidden
                importantForAccessibility="no"
              />
            ) : (
              <View style={[styles.thumbnail, styles.thumbnailEmpty]} />
            )}

            <View style={styles.text}>
              {/* The URL until extraction names it — a record with no title is
                still a record of something, and the link is what the user
                pasted. */}
              <Text style={styles.title} numberOfLines={1}>
                {add.title ?? add.url}
              </Text>
              <Text
                style={[styles.detail, add.status === 'failed' && styles.failed]}
                numberOfLines={1}
              >
                {shown}
              </Text>
              {/* How it was refused, under what it means (#582).
                #441 put the *kind* first and that stands — "is this worth
                trying again" is what a user wants. What it also did was drop
                the raw message entirely, and with it the status and byte
                offset: "The source refused the download" is the same sentence
                for a 403 at byte 0, a 403 after the first megabyte and a
                timeout eight megabytes in. Second line, muted, one line tall —
                ignorable by anyone who does not want it and there for the
                person who does. */}
              {technical !== null ? (
                <Text style={styles.technical} numberOfLines={1}>
                  {technical}
                </Text>
              ) : null}
            </View>

            {add.status === 'working' ? <ActivityIndicator /> : null}

            {add.status === 'failed' && onRetry ? (
              <Button
                label={t('deviceAdds.retry')}
                variant="plain"
                onPress={() => onRetry(add.url)}
                accessibilityLabel={t('deviceAdds.retryAria', { title: add.title ?? add.url })}
              />
            ) : null}

            {add.status !== 'working' ? (
              <Button
                label={'×'}
                variant="plain"
                onPress={() => forget(add.url)}
                accessibilityLabel={t('deviceAdds.forgetAria', { title: add.title ?? add.url })}
              />
            ) : null}
          </View>
        )
      })}
    </View>
  )
}

/** Which string a record deserves, with no `t` in it — the interesting part is
 *  the choice, and it is the same choice in every language. */
export function detailKeyFor(add: DeviceAdd): 'working' | 'done' | 'interrupted' | 'failed' {
  if (add.status === 'working') return 'working'
  if (add.status === 'done') return 'done'
  // Interrupted is its own sentence: nothing was wrong with the link, the app
  // was killed while it was downloading, and "failed" would send someone
  // looking for a fault that is not there.
  return add.error === 'interrupted' ? 'interrupted' : 'failed'
}

/**
 * Which step a working record is on.
 *
 * `working` is the fallback rather than an error: a record rehydrated from a
 * build before #430 has no phase, and neither does one in the moment between
 * `started` and the first report.
 */
export function phaseKeyFor(add: DeviceAdd): 'working' | 'extracting' | 'downloading' | 'saving' {
  if (add.phase === 'extracting') return 'extracting'
  if (add.phase === 'downloading') return 'downloading'
  if (add.phase === 'saving') return 'saving'
  return 'working'
}

/**
 * Whether the attempt counter is worth showing.
 *
 * Not on the first attempt, where it is noise on every ordinary add. From the
 * second on it is the whole point — it is what distinguishes a download working
 * its way through the client chain from one that has stopped.
 */
export function showsAttempt(add: DeviceAdd): boolean {
  return add.status === 'working' && (add.attempt ?? 1) > 1 && (add.attempts ?? 0) > 1
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    block: { gap: 8, marginTop: 20 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    heading: { fontSize: 13, fontWeight: '600', color: theme.textMuted },
    clear: { fontSize: 13, color: theme.accentOnSurface },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    thumbnail: { width: 40, height: 40, borderRadius: 6, backgroundColor: theme.surfaceMuted },
    thumbnailEmpty: { alignItems: 'center', justifyContent: 'center' },
    text: { flex: 1, minWidth: 0 },
    title: { fontSize: 14, fontWeight: '500', color: theme.text },
    detail: { fontSize: 12, color: theme.textMuted, marginTop: 2 },
    failed: { color: theme.danger },
    /** Quieter than `detail`, which is already the muted line: this one is
     *  for whoever is debugging, and must not compete with the sentence
     *  above it that says what to do (#582). */
    technical: { fontSize: 11, color: theme.textMuted, opacity: 0.7, marginTop: 1 },
    action: { fontSize: 13, fontWeight: '600', color: theme.accentOnSurface },
    dismiss: { fontSize: 20, color: theme.textMuted, paddingHorizontal: 4 },
  })

import { useTranslation } from 'react-i18next'
import { StyleSheet, Text, View } from 'react-native'

import { Chip } from './ui/Chip'
import { showToast } from './Toast'
import { useSearchSource, type SearchSource } from '../library/searchSource'
import { useThemedStyles, type Theme } from '../theme'

/**
 * Choosing which site MiO searches (#551).
 *
 * ## Why this is a visible control and not a setting nobody finds
 *
 * A user in mainland China cannot reach YouTube, so for them the default source
 * does not degrade — it fails completely, on every search and every playlist
 * import. That is not a preference, it is whether the app works, so the control
 * sits where searching happens rather than only in Settings.
 *
 * `full` adds the explanation and the VPN note; the compact form is chips
 * alone, for screens that already have a job to do.
 *
 * ## What it does not do
 *
 * It does not route downloads. A candidate's URL decides that — `platformOf()`
 * reads it and `importToDevice` picks the extractor (#492) — so choosing
 * Bilibili here means Bilibili URLs, which means the Bilibili extractor, with
 * no second decision to keep in step.
 */
export function SearchSourcePicker({ full = false }: { full?: boolean }) {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const source = useSearchSource((state) => state.source)
  const setSource = useSearchSource((state) => state.setSource)

  const choose = (next: SearchSource) => {
    if (next === source) return
    void setSource(next)
    // Confirmed out loud, because the effect of this control is invisible until
    // the *next* search — and on the compact form there is no other feedback
    // that the tap did anything.
    showToast(t('searchSource.changed', { source: t(`searchSource.${next}`) }))
  }

  return (
    <View style={styles.wrap}>
      {full ? <Text style={styles.intro}>{t('searchSource.intro')}</Text> : null}

      <View style={styles.row}>
        <Chip
          label={t('searchSource.youtube')}
          selected={source === 'youtube'}
          onPress={() => choose('youtube')}
        />
        <Chip
          label={t('searchSource.bilibili')}
          selected={source === 'bilibili'}
          onPress={() => choose('bilibili')}
        />
      </View>

      {full ? <Text style={styles.hint}>{t('searchSource.chinaHint')}</Text> : null}

      {/* Shown whenever Bilibili is chosen, compact or not: matching a long
          playlist really is slower, because the endpoint refuses above about
          one search a second (`docs/bilibili.md` §2.2). Better said before the
          wait than discovered during it. */}
      {source === 'bilibili' ? (
        <Text style={styles.hint}>{t('searchSource.bilibiliNote')}</Text>
      ) : null}
    </View>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    wrap: { gap: 8 },
    row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
    intro: { fontSize: 13, color: theme.text },
    hint: { fontSize: 12, color: theme.textMuted },
  })

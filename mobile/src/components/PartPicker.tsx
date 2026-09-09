import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native'

import { formatDuration } from '../api/songs'
import type { BilibiliPart } from '../library/bilibili'
import { useThemedStyles, type Theme } from '../theme'
import { Button } from './ui/Button'

interface Props {
  /** The upload's own title, which is what the parts belong to. */
  title: string
  parts: readonly BilibiliPart[]
  busy?: boolean
  /** The chosen parts, in the order the list shows them. */
  onConfirm: (parts: BilibiliPart[]) => void
  onClose: () => void
}

/**
 * Which parts of a multi-part upload to import (#575).
 *
 * Bilibili calls these 多P: one upload split into numbered parts. An album
 * published that way is routinely thirty of them, and #575's first half made a
 * pasted `?p=3` fetch part 3 instead of part 1. This is the second half —
 * 2026-08-17: *"yes we asked, and we allow user to select which
 * episodes, or select all"*.
 *
 * ## Why it asks rather than importing everything
 *
 * Because 多P is not only used for albums. A ninety-minute lecture split into
 * six parts is the same shape, and importing all of it unasked would put six
 * fifteen-minute tracks in someone's library because they pasted one link.
 * Asking costs one sheet and cannot be wrong.
 *
 * It only appears when there is a question: a single-part video never reaches
 * here, and goes straight down the ordinary add-link path.
 *
 * ## Everything is selected when it opens
 *
 * The common case is an album, where "all of it" is the answer — so the work is
 * in *deselecting* the odd track rather than tapping thirty rows. Select-all is
 * still there for getting back, and it flips to Clear once everything is on,
 * which is the same affordance `SelectionBar` offers.
 */
export function PartPicker({ title, parts, busy = false, onConfirm, onClose }: Props) {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)

  const [chosen, setChosen] = useState<ReadonlySet<number>>(
    () => new Set(parts.map((part) => part.page)),
  )

  const allSelected = chosen.size === parts.length
  const selected = useMemo(() => parts.filter((part) => chosen.has(part.page)), [parts, chosen])

  const toggle = (page: number) =>
    setChosen((current) => {
      const next = new Set(current)
      if (!next.delete(page)) next.add(page)
      return next
    })

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={({ pressed }) => [styles.backdrop, pressed && styles.pressed]}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel={t('common.cancel')}
      />
      <View style={styles.sheet}>
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
        <Text style={styles.subtitle}>{t('parts.intro', { count: parts.length })}</Text>

        <View style={styles.toolbar}>
          <Text style={styles.count}>{t('parts.selected', { count: chosen.size })}</Text>
          <Button
            label={allSelected ? t('select.none') : t('select.all')}
            variant="plain"
            onPress={() =>
              setChosen(allSelected ? new Set() : new Set(parts.map((part) => part.page)))
            }
          />
        </View>

        <FlatList
          data={parts}
          keyExtractor={(part) => String(part.page)}
          style={styles.list}
          // The set is a new object on every toggle, which is what tells the
          // list a row's tick changed — the rows themselves are not memoized.
          extraData={chosen}
          renderItem={({ item }) => {
            const checked = chosen.has(item.page)
            return (
              <Pressable
                onPress={() => toggle(item.page)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked }}
                accessibilityLabel={t(checked ? 'select.deselectAria' : 'select.selectAria', {
                  title: item.title,
                })}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <View style={[styles.tick, checked && styles.tickOn]}>
                  {checked ? <Text style={styles.tickMark}>✓</Text> : null}
                </View>
                {/* The part number, because an album's parts are often titled
                    so similarly that the number is the only way to tell two
                    rows apart — and it is what `?p=` names. */}
                <Text style={styles.page}>{item.page}</Text>
                <View style={styles.text}>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.title}
                  </Text>
                </View>
                <Text style={styles.duration}>{formatDuration(item.durationSeconds)}</Text>
              </Pressable>
            )
          }}
        />

        <View style={styles.actions}>
          <Button label={t('common.cancel')} variant="plain" onPress={onClose} />
          <Button
            label={t('parts.confirm', { count: chosen.size })}
            variant="filled"
            busy={busy}
            // Nothing chosen is a button that would do nothing, which is worse
            // than one that is visibly unavailable.
            disabled={busy || chosen.size === 0}
            onPress={() => onConfirm(selected)}
          />
        </View>
      </View>
    </Modal>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    // The same scrim `SongPicker` uses, and hardcoded there too: it sits over
    // both themes and is not a palette token.
    backdrop: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.45)' },
    pressed: { backgroundColor: theme.surfacePressed },
    sheet: {
      position: 'absolute',
      left: 16,
      right: 16,
      top: '10%',
      bottom: '10%',
      backgroundColor: theme.surface,
      borderRadius: 16,
      padding: 16,
      gap: 8,
    },
    title: { fontSize: 17, fontWeight: '600', color: theme.text },
    subtitle: { fontSize: 13, color: theme.textMuted },
    toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    count: { fontSize: 13, color: theme.textMuted },
    list: { flex: 1 },
    row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 12 },
    tick: {
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 2,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tickOn: { backgroundColor: theme.accentSolid, borderColor: theme.accentSolid },
    tickMark: { color: theme.accentText, fontSize: 13, fontWeight: '700', lineHeight: 16 },
    page: { fontSize: 13, color: theme.textMuted, minWidth: 24 },
    text: { flex: 1, minWidth: 0 },
    name: { fontSize: 15, color: theme.text },
    duration: { fontSize: 13, color: theme.textMuted },
    actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  })

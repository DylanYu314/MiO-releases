import { useTranslation } from 'react-i18next'

import { usePlayer } from '../player/store'
import { ActionSheet, type SheetAction } from './ActionSheet'

/** Sleep-timer choices, in minutes, plus the two special cases. */
const SLEEP_MINUTES = [5, 15, 30, 45, 60]

interface Props {
  visible: boolean
  onClose: () => void
}

/**
 * The sleep-timer choices, in one place (#313).
 *
 * Lifted out of `PlayingOptionsSheet` when the queue's sleep chip became
 * pressable. The chip used to be a read-only `View`, on the reasoning that the
 * timer should be *set* from one place so there would not be two to keep in
 * step — and the reasoning was sound about the options while being wrong about
 * the chip: a control that shows a setting and refuses to change it is a
 * control that looks broken, which is how I reported it.
 *
 * So there are two entry points now and still **one list**. Duplicating the
 * options is the thing the original decision was actually protecting against.
 */
export function SleepTimerSheet({ visible, onClose }: Props) {
  const { t } = useTranslation()
  const sleepAt = usePlayer((state) => state.sleepAt)
  const sleepAfterTrack = usePlayer((state) => state.sleepAfterTrack)

  const actions: readonly SheetAction[] = [
    {
      key: 'sleep-off',
      label: `${t('player.sleepOff')}${sleepAt === null && !sleepAfterTrack ? '  ✓' : ''}`,
      onPress: () => usePlayer.getState().setSleepTimer(null),
    },
    ...SLEEP_MINUTES.map((minutes) => ({
      key: `sleep-${minutes}`,
      label: t('player.sleepMinutes', { count: minutes }),
      onPress: () => usePlayer.getState().setSleepTimer(minutes),
    })),
    {
      key: 'sleep-end',
      label: `${t('player.sleepEndOfTrack')}${sleepAfterTrack ? '  ✓' : ''}`,
      onPress: () => usePlayer.getState().setSleepTimer('endOfTrack'),
    },
  ]

  return (
    <ActionSheet
      visible={visible}
      title={t('player.sleepTimer')}
      actions={actions}
      onClose={onClose}
    />
  )
}

import { useTranslation } from 'react-i18next'
import { StyleSheet, Text, View } from 'react-native'

import { JOB_PROGRESS_STEPS, type Job } from '../api/types'
import { useThemedStyles, type Theme } from '../theme'

/**
 * The backend's job state machine, made visible (ADR-001).
 *
 * A phone port of the web client's component, and deliberately the same shape:
 * the same four steps, the same strings from the shared catalogue. Someone who
 * has used MiO in a browser should recognise this immediately.
 *
 * Downloading takes tens of seconds, so silence here reads as "nothing is
 * happening" and gets the link pasted twice.
 */
export function JobProgress({ job }: { job: Job }) {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)

  if (job.status === 'failed') {
    return (
      <View style={[styles.card, styles.failed]} accessibilityRole="alert">
        <Text style={styles.failedTitle}>{t('jobProgress.failed')}</Text>
        {/*
         * A sentence about what happened, not yt-dlp's output (#177). What used
         * to appear here told the user to pass `--cookies-from-browser` to a
         * server they do not administer.
         *
         * The raw text stays, below and quieter: it is the only thing of use when
         * something genuinely unexpected breaks, and hiding it entirely would
         * trade one unusable failure for an undiagnosable one.
         */}
        <Text style={styles.failedBody}>
          {job.error_code ? t(`failure.${job.error_code}`) : t('jobProgress.noError')}
        </Text>
        {job.error ? (
          <Text style={styles.failedDetail} numberOfLines={3}>
            {t('jobProgress.technicalDetail')}: {job.error}
          </Text>
        ) : null}
      </View>
    )
  }

  if (job.status === 'done') {
    return (
      <View style={[styles.card, styles.done]}>
        <Text style={styles.doneTitle}>{t('jobProgress.done')}</Text>
      </View>
    )
  }

  const currentIndex = JOB_PROGRESS_STEPS.indexOf(job.status)

  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      <Text style={styles.status}>
        {t('jobProgress.inProgress', { status: t(`jobStatus.${job.status}`) })}
      </Text>
      <View style={styles.steps}>
        {JOB_PROGRESS_STEPS.map((step, index) => (
          <View key={step} style={styles.step}>
            <View style={[styles.bar, index <= currentIndex && styles.barFilled]} />
            <Text style={styles.stepLabel} numberOfLines={1}>
              {t(`jobStatus.${step}`)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    card: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: 10,
      padding: 16,
      marginTop: 20,
    },
    status: { fontSize: 15, fontWeight: '500', marginBottom: 12, color: theme.text },
    steps: { flexDirection: 'row', gap: 8 },
    step: { flex: 1 },
    bar: { height: 6, borderRadius: 999, backgroundColor: theme.surfaceMuted },
    barFilled: { backgroundColor: theme.accentSolid },
    stepLabel: { fontSize: 11, color: theme.textMuted, marginTop: 6 },
    failed: { borderColor: theme.dangerBorder, backgroundColor: theme.dangerBg },
    failedTitle: { fontSize: 15, fontWeight: '600', color: theme.danger },
    failedBody: { fontSize: 13, color: theme.danger, marginTop: 6 },
    // Present but plainly secondary: for the rare case where the raw text is the
    // only thing that helps, without competing with the sentence above it.
    failedDetail: { fontSize: 11, color: theme.danger, opacity: 0.65, marginTop: 8 },
    done: { borderColor: theme.successBorder, backgroundColor: theme.successBg },
    doneTitle: { fontSize: 15, fontWeight: '600', color: theme.success },
  })

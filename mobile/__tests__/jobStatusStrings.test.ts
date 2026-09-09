import en from '@mio/shared/i18n/en.json'
import zh from '@mio/shared/i18n/zh.json'

import { JOB_PROGRESS_STEPS, type JobStatus } from '../src/api/types'

/**
 * Every job status has a translation.
 *
 * ⚠️ **Found on a device, not by a test.** The "Other sites" history rendered
 * the literal string `jobStatus.done`, because the catalogue held only the four
 * *in-progress* statuses while the code interpolates whatever the job reports:
 *
 * ```ts
 * t(`jobStatus.${job.status}`)
 * ```
 *
 * A template key is invisible to every guard that looks for `t('literal')` —
 * which is why this asserts the **data** against the union instead. Same shape
 * as #561 (a string that existed and was never wired) and #557 (a catalogue
 * that looked complete and was not).
 */

/** The full set, not just the ones the progress bar walks through. */
const ALL_STATUSES: JobStatus[] = [
  'queued',
  'downloading',
  'converting',
  'tagging',
  'done',
  'failed',
]

describe('jobStatus translations', () => {
  it('covers every status a job can report, in both languages', () => {
    for (const status of ALL_STATUSES) {
      expect(en.jobStatus).toHaveProperty(status)
      expect(zh.jobStatus).toHaveProperty(status)
    }
  })

  it('has no blank ones, which would render as empty rather than as a key', () => {
    for (const status of ALL_STATUSES) {
      expect(String((en.jobStatus as Record<string, string>)[status]).trim()).not.toBe('')
      expect(String((zh.jobStatus as Record<string, string>)[status]).trim()).not.toBe('')
    }
  })

  it('includes the terminal statuses the progress steps deliberately omit', () => {
    // A control on the list above: `JOB_PROGRESS_STEPS` is the *bar*, which
    // stops at `tagging` on purpose. Reusing it here would have reproduced the
    // bug exactly — the catalogue matched those four and nothing noticed.
    expect(JOB_PROGRESS_STEPS).not.toContain('done')
    expect(JOB_PROGRESS_STEPS).not.toContain('failed')
    expect(ALL_STATUSES).toEqual(expect.arrayContaining([...JOB_PROGRESS_STEPS, 'done', 'failed']))
  })
})

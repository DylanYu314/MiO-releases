import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { Job, JobStatus } from '../api/types'
import { JobProgress } from './JobProgress'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 1,
    source_url: 'https://example.com/watch?v=abc',
    status: 'queued',
    progress: null,
    song_id: null,
    error: null,
    error_code: null,
    created_at: '2026-07-22T12:00:00Z',
    updated_at: '2026-07-22T12:00:00Z',
    ...overrides,
  }
}

// The heading renders the translated status, not the raw backend value.
const STAGE_LABELS: Record<string, string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  converting: 'Converting',
  tagging: 'Tagging',
}

describe('JobProgress', () => {
  it.each<JobStatus>(['queued', 'downloading', 'converting', 'tagging'])(
    'shows %s as the current stage',
    (status) => {
      render(<JobProgress job={makeJob({ status })} />)

      expect(screen.getByText(`${STAGE_LABELS[status]}...`)).toBeInTheDocument()
    },
  )

  it('reports success once the job is done', () => {
    render(<JobProgress job={makeJob({ status: 'done', song_id: 7 })} />)

    expect(screen.getByText('Added to your library')).toBeInTheDocument()
  })

  it('explains a failure in a sentence, not in yt-dlp output (#177)', () => {
    // The real message from a failed production import. What used to be shown
    // first told the user to pass a command-line flag to a server they do not
    // administer.
    const raw =
      "ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you're not a bot. " +
      'Use --cookies-from-browser or --cookies for the authentication.'
    render(<JobProgress job={makeJob({ status: 'failed', error: raw, error_code: 'bot_check' })} />)

    expect(screen.getByRole('alert')).toHaveTextContent(
      'YouTube would not serve this video to the server',
    )
    // The raw text is still reachable — it is the only thing that helps when
    // something genuinely unexpected breaks — but it is behind a disclosure and
    // is no longer what the user reads first.
    expect(screen.getByText('Technical detail')).toBeInTheDocument()
    expect(screen.getByText(raw)).toBeInTheDocument()
  })

  it('translates whichever reason the backend named', () => {
    render(
      <JobProgress
        job={makeJob({ status: 'failed', error: 'Video unavailable', error_code: 'unavailable' })}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('This video is unavailable.')
  })

  it('falls back for a reason it does not recognise', () => {
    // `unknown` is a real code the backend sends, not an absence — so there is
    // always something to translate rather than raw text leaking into the slot.
    render(
      <JobProgress
        job={makeJob({ status: 'failed', error: 'Something new', error_code: 'unknown' })}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('The import failed.')
  })

  it('still renders a failure with no error recorded at all', () => {
    render(<JobProgress job={makeJob({ status: 'failed' })} />)

    expect(screen.getByRole('alert')).toHaveTextContent('No error message was recorded.')
    // Nothing to disclose, so no disclosure.
    expect(screen.queryByText('Technical detail')).not.toBeInTheDocument()
  })
})

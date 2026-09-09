import {
  buildReport,
  LOG_CAPACITY,
  REPORT_ENTRIES,
  type ReportContext,
} from '../src/diagnostics/report'
import type { LogEntry } from '../src/diagnostics/log'

const context: ReportContext = {
  appVersion: '1.0.0',
  runtimeVersion: '681661688a2e9d9aebf6dc2561535c2a9566f313',
  updateId: '01a02468',
  device: 'realme RMX3301',
  os: 'Android 35',
  at: Date.UTC(2026, 7, 21, 12, 0, 0),
}

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  key: Math.random().toString(36),
  level: 'info',
  event: 'import.started',
  detail: null,
  at: Date.UTC(2026, 7, 21, 11, 0, 0),
  ...over,
})

describe('buildReport', () => {
  it('carries the fields that made #651 diagnosable', () => {
    const text = buildReport([entry()], context)

    expect(text).toContain('1.0.0')
    expect(text).toContain('681661688a2e9d9aebf6dc2561535c2a9566f313')
    expect(text).toContain('01a02468')
    expect(text).toContain('realme RMX3301')
    expect(text).toContain('Android 35')
  })

  it('writes an entry as level, event and detail', () => {
    const text = buildReport(
      [entry({ level: 'error', event: 'import.failed', detail: 'status 403 at byte 0' })],
      context,
    )

    expect(text).toContain('ERROR')
    expect(text).toContain('import.failed')
    expect(text).toContain('status 403 at byte 0')
  })

  it('says the log is empty rather than producing a bare header', () => {
    // An empty log is a real answer: on 2026-08-20 an import that logged
    // *nothing* was the whole diagnosis (#655).
    const text = buildReport([], context)

    expect(text).toContain('Log is empty.')
    // Still worth sending — the header says which build it was.
    expect(text).toContain('1.0.0')
  })

  it('caps the entries and says that it did', () => {
    const many = Array.from({ length: REPORT_ENTRIES + 40 }, () => entry())
    const text = buildReport(many, context)

    expect(text).toContain(`${REPORT_ENTRIES} of ${REPORT_ENTRIES + 40} entries`)
    expect(text.split('\n').filter((l) => l.includes('import.started'))).toHaveLength(
      REPORT_ENTRIES,
    )
  })

  it('does not claim truncation when nothing was dropped', () => {
    const text = buildReport([entry(), entry()], context)

    expect(text).toContain('2 entries')
    expect(text).not.toContain(' of ')
  })

  it('keeps the newest entries, which are the ones that explain the failure', () => {
    const newest = entry({ event: 'the.newest' })
    const rest = Array.from({ length: REPORT_ENTRIES + 5 }, () => entry({ event: 'older' }))
    const text = buildReport([newest, ...rest], context)

    expect(text).toContain('the.newest')
  })

  it('caps below what the log retains, so something is always dropped rather than truncated downstream', () => {
    expect(REPORT_ENTRIES).toBeLessThan(LOG_CAPACITY)
  })

  it('survives a context with nothing in it', () => {
    // Every field is nullable and a report from a broken app is exactly when
    // they might be null. It must still produce something sendable.
    const text = buildReport([entry()], {
      appVersion: null,
      runtimeVersion: null,
      updateId: '—',
      device: null,
      os: null,
      at: context.at,
    })

    expect(text).toContain('MiO problem report')
    expect(text).toContain('import.started')
  })
})

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'

import { ApiError } from '../api/client'
import { useCreateJob } from '../api/jobs'
import { useSearch } from '../api/search'
import type { SearchPlatform, SearchResult } from '../api/types'
import { ImportGate } from '../components/ImportGate'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { Input } from '../components/ui/Input'
import { Select } from '../components/ui/Select'
import { Spinner } from '../components/ui/Spinner'
import { useToast } from '../components/ui/toast/context'
import { formatDuration } from '../lib/format'

const PLATFORMS: SearchPlatform[] = ['youtube', 'bilibili']

export function SearchPage() {
  const { t } = useTranslation()
  // The query and platform live in the URL (?q=&platform=), so a search — and
  // its cached results — survive both navigation away and a reload, the same
  // way the add-link job pointer does.
  const [searchParams, setSearchParams] = useSearchParams()
  const query = searchParams.get('q') ?? ''
  const platform: SearchPlatform =
    searchParams.get('platform') === 'bilibili' ? 'bilibili' : 'youtube'
  // The text field is local and seeded from the URL, so typing doesn't rewrite
  // history on every keystroke — only submitting does.
  const [input, setInput] = useState(query)

  const { data, isFetching, isError, error } = useSearch(platform, query)

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = input.trim()
    setSearchParams(trimmed ? { q: trimmed, platform } : { platform })
  }

  function handlePlatformChange(next: SearchPlatform) {
    setSearchParams(query ? { q: query, platform: next } : { platform: next }, { replace: true })
  }

  return (
    <ImportGate>
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            {t('search.title')}
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t('search.subtitle')}</p>
        </div>

        <form onSubmit={handleSubmit} className="flex gap-2">
          <Select
            value={platform}
            onChange={(event) => handlePlatformChange(event.target.value as SearchPlatform)}
            aria-label={t('search.platform')}
          >
            {PLATFORMS.map((name) => (
              <option key={name} value={name}>
                {t(`search.platforms.${name}`)}
              </option>
            ))}
          </Select>
          <Input
            type="search"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={t('search.placeholder')}
            aria-label={t('search.title')}
            className="flex-1"
          />
          <Button type="submit" loading={isFetching}>
            {t('search.submit')}
          </Button>
        </form>

        {isError && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {/* Bilibili refuses roughly half of spaced requests as suspected
                crawling. That is common enough to deserve its own wording, in
                the user's language, rather than the extractor's English. */}
            {error instanceof ApiError && error.status === 503
              ? t('search.rateLimited')
              : error.message}
          </p>
        )}

        <Results query={query} results={data} isFetching={isFetching} />
      </div>
    </ImportGate>
  )
}

function Results({
  query,
  results,
  isFetching,
}: {
  query: string
  results: SearchResult[] | undefined
  isFetching: boolean
}) {
  const { t } = useTranslation()

  if (!query) return null
  if (!results) {
    return isFetching ? (
      <div className="flex justify-center py-8">
        <Spinner className="h-6 w-6 text-slate-400" />
      </div>
    ) : null
  }
  if (results.length === 0) return <EmptyState title={t('search.noResults')} />

  return (
    <ul className="space-y-2">
      {results.map((result) => (
        <ResultRow key={result.url} result={result} />
      ))}
    </ul>
  )
}

function ResultRow({ result }: { result: SearchResult }) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const createJob = useCreateJob()
  const [added, setAdded] = useState(false)

  const meta = [result.uploader, result.duration ? formatDuration(result.duration) : null]
    .filter(Boolean)
    .join(' · ')

  function handleAdd() {
    createJob.mutate(result.url, {
      onSuccess: () => {
        setAdded(true)
        toast(t('search.added', { title: result.title }), 'success')
      },
      onError: (err) => toast(err.message, 'error'),
    })
  }

  return (
    <li className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-800">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-slate-900 dark:text-slate-100">{result.title}</p>
        {meta && <p className="truncate text-sm text-slate-500 dark:text-slate-400">{meta}</p>}
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={handleAdd}
        loading={createJob.isPending}
        disabled={added}
      >
        {added ? t('search.addedShort') : t('search.add')}
      </Button>
    </li>
  )
}

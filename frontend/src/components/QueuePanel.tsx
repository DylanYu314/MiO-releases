import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'

import type { Song } from '../api/types'
import { formatDuration } from '../lib/format'
import { selectContextUpNext, usePlayerStore } from '../player/store'
import { Button } from './ui'

interface QueuePanelProps {
  open: boolean
  onClose: () => void
}

/** One draggable row. `id` is a stable string key, not the song id — the same
 *  song can legitimately appear more than once in a queue. */
function QueueRow({
  id,
  song,
  onRemove,
  removeLabel,
}: {
  id: string
  song: Song
  onRemove: () => void
  removeLabel: string
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  })
  const { t } = useTranslation()

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-2 dark:border-slate-700 dark:bg-slate-800 ${
        isDragging ? 'z-10 opacity-80 shadow-lg' : ''
      }`}
    >
      <button
        type="button"
        // dnd-kit's keyboard sensor drives reordering from this handle, so it
        // has to be a real focusable control, not a decorative grip.
        {...attributes}
        {...listeners}
        aria-label={t('queue.dragAria', { title: song.title })}
        className="shrink-0 cursor-grab touch-none rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-700 dark:hover:text-slate-300"
      >
        <GripVertical className="h-4 w-4" aria-hidden />
      </button>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
          {song.title}
        </p>
        <p className="truncate text-xs text-slate-500 dark:text-slate-400">{song.artist}</p>
      </div>

      <span className="shrink-0 text-xs tabular-nums text-slate-400">
        {formatDuration(song.duration)}
      </span>

      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        className="shrink-0 rounded p-1 text-slate-400 transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-400"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </li>
  )
}

/**
 * The play queue, in the two tiers ADR-011 describes: what you queued by hand,
 * then what's left of the list you're playing. Both are reorderable and
 * prunable; only the manual one can be cleared on its own.
 */
export function QueuePanel({ open, onClose }: QueuePanelProps) {
  const { t } = useTranslation()
  const closeRef = useRef<HTMLButtonElement>(null)

  const current = usePlayerStore((state) => state.current)
  const userQueue = usePlayerStore((state) => state.userQueue)
  const context = usePlayerStore((state) => state.context)
  const contextIndex = usePlayerStore((state) => state.contextIndex)
  // selectContextUpNext derives a fresh array, so it needs a shallow compare —
  // with Zustand's default reference equality every render looks like a change
  // and the component re-renders forever.
  const upNext = usePlayerStore(useShallow(selectContextUpNext))

  const removeFromUserQueue = usePlayerStore((state) => state.removeFromUserQueue)
  const removeFromContextQueue = usePlayerStore((state) => state.removeFromContextQueue)
  const reorderUserQueue = usePlayerStore((state) => state.reorderUserQueue)
  const reorderContextUpNext = usePlayerStore((state) => state.reorderContextUpNext)
  const clearUserQueue = usePlayerStore((state) => state.clearUserQueue)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  const userIds = userQueue.map((_, index) => `user-${index}`)
  const contextIds = upNext.map((_, index) => `context-${index}`)

  function handleDragEnd(
    event: DragEndEvent,
    ids: string[],
    apply: (a: number, b: number) => void,
  ) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    apply(ids.indexOf(String(active.id)), ids.indexOf(String(over.id)))
  }

  // The context pointer sits at the track before `upNext`, so removing entry i
  // from the panel means removing that offset position from the playback order.
  const contextOffset = contextIndex + 1

  return (
    <>
      <div
        className="fixed inset-0 z-30 bg-black/30"
        onClick={onClose}
        aria-hidden
        data-testid="queue-backdrop"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={t('queue.title')}
        className="fixed bottom-0 right-0 top-0 z-40 flex w-full max-w-md flex-col border-l border-slate-200 bg-slate-50 shadow-xl dark:border-slate-700 dark:bg-slate-900"
      >
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-700">
          <h2 className="font-semibold text-slate-900 dark:text-slate-100">{t('queue.title')}</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={t('queue.close')}
            className="rounded p-1 text-slate-500 transition hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-700"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4">
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {t('queue.nowPlaying')}
            </h3>
            {current ? (
              <div className="rounded-lg border border-accent-400 bg-white p-2 dark:border-accent-500 dark:bg-slate-800">
                <p className="truncate text-sm font-medium text-accent-600 dark:text-accent-400">
                  {current.song.title}
                </p>
                <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                  {current.song.artist}
                </p>
              </div>
            ) : (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {t('queue.nothingPlaying')}
              </p>
            )}
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                {t('queue.nextInQueue')}
              </h3>
              {userQueue.length > 0 && (
                <Button variant="ghost" size="sm" onClick={clearUserQueue}>
                  {t('queue.clear')}
                </Button>
              )}
            </div>
            {userQueue.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">{t('queue.emptyUser')}</p>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                modifiers={[restrictToVerticalAxis, restrictToParentElement]}
                onDragEnd={(event) => handleDragEnd(event, userIds, reorderUserQueue)}
              >
                <SortableContext items={userIds} strategy={verticalListSortingStrategy}>
                  <ul className="space-y-2">
                    {userQueue.map((song, index) => (
                      <QueueRow
                        key={userIds[index]}
                        id={userIds[index]}
                        song={song}
                        onRemove={() => removeFromUserQueue(index)}
                        removeLabel={t('queue.removeAria', { title: song.title })}
                      />
                    ))}
                  </ul>
                </SortableContext>
              </DndContext>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {context?.name
                ? t('queue.nextFromNamed', { name: context.name })
                : t('queue.nextFrom')}
            </h3>
            {upNext.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                {t('queue.emptyContext')}
              </p>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                modifiers={[restrictToVerticalAxis, restrictToParentElement]}
                onDragEnd={(event) => handleDragEnd(event, contextIds, reorderContextUpNext)}
              >
                <SortableContext items={contextIds} strategy={verticalListSortingStrategy}>
                  <ul className="space-y-2">
                    {upNext.map((song, index) => (
                      <QueueRow
                        key={contextIds[index]}
                        id={contextIds[index]}
                        song={song}
                        onRemove={() => removeFromContextQueue(contextOffset + index)}
                        removeLabel={t('queue.removeAria', { title: song.title })}
                      />
                    ))}
                  </ul>
                </SortableContext>
              </DndContext>
            )}
          </section>
        </div>
      </aside>
    </>
  )
}

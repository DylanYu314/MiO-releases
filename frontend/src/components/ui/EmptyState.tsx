import type { ReactNode } from 'react'

/** A friendly placeholder for empty lists: an optional icon/illustration, a
 *  title, an optional description, and an optional action. */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-slate-300 px-4 py-10 text-center dark:border-slate-700">
      {icon && <div className="text-slate-400 dark:text-slate-500">{icon}</div>}
      <p className="font-medium text-slate-700 dark:text-slate-200">{title}</p>
      {description && (
        <p className="max-w-sm text-sm text-slate-500 dark:text-slate-400">{description}</p>
      )}
      {action}
    </div>
  )
}

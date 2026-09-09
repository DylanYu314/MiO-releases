/** Format a duration in seconds as m:ss (or h:mm:ss when over an hour). */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '--:--'

  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60

  const paddedSecs = String(secs).padStart(2, '0')
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${paddedSecs}`
  return `${minutes}:${paddedSecs}`
}

/**
 * The opening-animation slot (Enhancement Track B4).
 *
 * This is a *placeholder*: an accent-gradient panel with the wordmark and a set
 * of equaliser bars that animate unless the viewer prefers reduced motion. When
 * the real opening animation (a Lottie file) is produced, drop it in here in
 * place of the placeholder markup — nothing else needs to change.
 */
export function OpeningAnimation() {
  return (
    <div
      role="img"
      aria-label="MiO"
      className="flex h-36 flex-col items-center justify-center gap-3 rounded-lg bg-gradient-to-br from-accent-500 to-accent-700"
    >
      <div className="flex h-8 items-end gap-1" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className="w-1.5 rounded-full bg-white/90 motion-safe:animate-bounce"
            style={{ height: `${40 + ((i * 37) % 60)}%`, animationDelay: `${i * 120}ms` }}
          />
        ))}
      </div>
      {/* eslint-disable-next-line i18next/no-literal-string -- the wordmark is
          the product name; it stays "MiO" in every language. */}
      <span className="text-4xl font-bold tracking-tight text-white">MiO</span>
    </div>
  )
}

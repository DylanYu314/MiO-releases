/** Join class names, dropping falsy entries. A tiny local stand-in for `clsx`
 *  so the primitives can compose variant classes without adding a dependency. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

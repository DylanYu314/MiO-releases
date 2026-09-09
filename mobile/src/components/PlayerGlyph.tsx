import { StyleSheet, View, type ColorValue } from 'react-native'
import Svg, { Path } from 'react-native-svg'

export type PlayerGlyphName =
  'play' | 'pause' | 'next' | 'previous' | 'shuffle' | 'repeat' | 'repeat-one'

interface Props {
  name: PlayerGlyphName
  color: ColorValue
  size: number
}

/**
 * The transport shapes, drawn from plain views.
 *
 * Same reasoning as `TabGlyph`: the app has no icon set, and a vector package is
 * a font asset plus a native config plugin — which on this project also means an
 * EAS rebuild before anyone can see it. These were already inline in
 * `NowPlayingBar`; the playing panel needs the same shapes larger, so they moved
 * here rather than being written a second time.
 *
 * ## Shuffle and repeat are lucide now (#326)
 *
 * *"icons for random shuffle and repeat can use the one we used on web,
 * current one we have in app are ass."* Fair — the docblock above already
 * conceded these two were the ones a drawn glyph served badly. Crossing arrows
 * and a looped arrow both want a real path, and what was here was two rotated
 * bars and a plain ring.
 *
 * They are the **only** two that changed. Play, pause, next and previous are
 * triangles and rectangles, which a `View` draws exactly and an icon package
 * would not improve — and the playing panel is a surface not to redesign
 * beyond what was asked for.
 *
 * The cost is `react-native-svg`, a native dependency, which is why this waited
 * for the one S8 build rather than spending a 20-minute cycle of its own.
 *
 * ## Why the paths are here rather than `lucide-react-native`
 *
 * That package was installed first and taken back out. It ships ESM only, jest
 * does not transform `node_modules` without being told to, and its `.mjs` files
 * do not match the preset's `\.[jt]sx?$` transform either — so it needed a
 * `transformIgnorePatterns` override *and* a transform for a new extension,
 * both of which mean rebuilding jest-expo's own lists by hand and getting them
 * right forever after.
 *
 * A whole icon library and two pieces of jest surgery, for three icons. The
 * path data below is lucide's, copied verbatim (ISC), so these are the same
 * marks the web client draws from `lucide-react`, not lookalikes — and
 * `PlayerGlyph` stays what it already was: one file that knows every shape the
 * transport uses.
 */

/**
 * Lucide's own path data, verbatim (ISC, © Lucide Icons and Contributors).
 *
 * Their 24x24 grid, 2px stroke, round caps and joins — reproduced exactly so
 * these match `lucide-react` on the web rather than approximating it.
 */
const LUCIDE_VIEWBOX = '0 0 24 24'

const SHUFFLE_PATHS = [
  'm18 14 4 4-4 4',
  'm18 2 4 4-4 4',
  'M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22',
  'M2 6h1.972a4 4 0 0 1 3.6 2.2',
  'M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45',
]

const REPEAT_PATHS = [
  'm17 2 4 4-4 4',
  'M3 11v-1a4 4 0 0 1 4-4h14',
  'm7 22-4-4 4-4',
  'M21 13v1a4 4 0 0 1-4 4H3',
]

/** Repeat, plus the `1` lucide draws inside the loop. */
const REPEAT_ONE_PATHS = [...REPEAT_PATHS, 'M11 10h1v4']

function LucideGlyph({
  paths,
  color,
  size,
}: {
  paths: readonly string[]
  color: ColorValue
  size: number
}) {
  return (
    <Svg width={size} height={size} viewBox={LUCIDE_VIEWBOX} fill="none">
      {paths.map((d) => (
        <Path
          key={d}
          d={d}
          stroke={color as string}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  )
}

export function PlayerGlyph({ name, color, size }: Props) {
  switch (name) {
    case 'play':
      return (
        <View
          style={{
            width: 0,
            height: 0,
            borderTopWidth: size * 0.5,
            borderBottomWidth: size * 0.5,
            borderLeftWidth: size * 0.85,
            borderTopColor: 'transparent',
            borderBottomColor: 'transparent',
            borderLeftColor: color,
            // Optically centred: a triangle's visual mass sits left of its box.
            marginLeft: size * 0.15,
          }}
        />
      )

    case 'pause':
      return (
        <View style={[styles.row, { gap: size * 0.22 }]}>
          <View
            style={{ width: size * 0.26, height: size, backgroundColor: color, borderRadius: 1 }}
          />
          <View
            style={{ width: size * 0.26, height: size, backgroundColor: color, borderRadius: 1 }}
          />
        </View>
      )

    // A triangle plus a bar, mirrored by which side the bar sits on.
    case 'next':
      return (
        <View style={[styles.row, { gap: size * 0.06 }]}>
          <Triangle color={color} size={size} />
          <View style={{ width: size * 0.16, height: size * 0.8, backgroundColor: color }} />
        </View>
      )

    case 'previous':
      return (
        <View style={[styles.row, { gap: size * 0.06 }]}>
          <View style={{ width: size * 0.16, height: size * 0.8, backgroundColor: color }} />
          <Triangle color={color} size={size} flipped />
        </View>
      )

    case 'shuffle':
      return <LucideGlyph paths={SHUFFLE_PATHS} color={color} size={size} />

    case 'repeat':
      return <LucideGlyph paths={REPEAT_PATHS} color={color} size={size} />

    // A separate name rather than a prop, so the panel picks the icon the same
    // way the web client does — `Repeat1` carries "one" in the mark itself
    // instead of a digit stacked on top of a ring.
    case 'repeat-one':
      return <LucideGlyph paths={REPEAT_ONE_PATHS} color={color} size={size} />
  }
}

function Triangle({
  color,
  size,
  flipped = false,
}: {
  color: ColorValue
  size: number
  flipped?: boolean
}) {
  return (
    <View
      style={{
        width: 0,
        height: 0,
        borderTopWidth: size * 0.4,
        borderBottomWidth: size * 0.4,
        borderTopColor: 'transparent',
        borderBottomColor: 'transparent',
        ...(flipped
          ? { borderRightWidth: size * 0.62, borderRightColor: color }
          : { borderLeftWidth: size * 0.62, borderLeftColor: color }),
      }}
    />
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
})

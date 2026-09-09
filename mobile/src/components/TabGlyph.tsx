import { StyleSheet, View, type ColorValue } from 'react-native'

export type TabGlyphName = 'library' | 'playlists' | 'add' | 'settings'

interface Props {
  name: TabGlyphName
  /** `ColorValue`, not `string`: this is what the navigator hands `tabBarIcon`,
   *  and it is only ever passed straight to a style. */
  color: ColorValue
  size: number
}

/**
 * The four tab icons, drawn from plain views.
 *
 * The same reasoning as `NowPlayingBar`'s transport controls: the app has no
 * icon set, and four shapes do not justify adding one — a vector icon package
 * is a font asset plus a native config plugin, which on this project also means
 * an EAS rebuild before anyone can see it (see `docs/mobile-testing.md`).
 *
 * They are deliberately plain rather than clever. Each is legible at 24px on a
 * phone, which is the only size that matters, and each reads as its destination
 * without a label to help — though it always has one, because an unlabelled
 * hand-drawn glyph is a guessing game.
 */
export function TabGlyph({ name, color, size }: Props) {
  switch (name) {
    // A music note: a filled head with a stem, which is the one shape that says
    // "your music" without needing to be recognised as anything else.
    case 'library':
      return (
        <View style={[styles.box, { width: size, height: size }]}>
          <View
            style={[
              styles.noteHead,
              { backgroundColor: color, width: size * 0.42, height: size * 0.33 },
            ]}
          />
          <View
            style={[
              styles.noteStem,
              { backgroundColor: color, height: size * 0.72, right: size * 0.24 },
            ]}
          />
        </View>
      )

    // Stacked lines, the last one short: a list that continues past what is
    // drawn, which is what a playlist collection is.
    case 'playlists':
      return (
        <View style={[styles.box, styles.stack, { width: size, height: size }]}>
          <View style={[styles.line, { backgroundColor: color, width: size * 0.82 }]} />
          <View style={[styles.line, { backgroundColor: color, width: size * 0.82 }]} />
          <View style={[styles.line, { backgroundColor: color, width: size * 0.5 }]} />
        </View>
      )

    // A plus. Two bars, because a `+` glyph in text would inherit the font's
    // metrics and refuse to sit on the same baseline as the drawn icons.
    case 'add':
      return (
        <View style={[styles.box, { width: size, height: size }]}>
          <View
            style={[
              styles.bar,
              { backgroundColor: color, width: size * 0.78, height: size * 0.14 },
            ]}
          />
          <View
            style={[
              styles.bar,
              { backgroundColor: color, width: size * 0.14, height: size * 0.78 },
            ]}
          />
        </View>
      )

    // Sliders rather than a gear: a gear's teeth need a real vector path, and
    // three tracks with handles at different positions say "settings" just as
    // clearly out of rectangles.
    case 'settings':
      return (
        <View style={[styles.box, styles.stack, { width: size, height: size }]}>
          {[0.62, 0.22, 0.44].map((offset, index) => (
            <View key={index} style={[styles.sliderRow, { width: size * 0.86 }]}>
              <View style={[styles.line, styles.sliderTrack, { backgroundColor: color }]} />
              <View
                style={[
                  styles.sliderHandle,
                  {
                    backgroundColor: color,
                    width: size * 0.2,
                    height: size * 0.2,
                    left: `${offset * 100}%`,
                  },
                ]}
              />
            </View>
          ))}
        </View>
      )
  }
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center' },
  stack: { gap: 3 },
  // Absolute so the two crossing bars of the plus share a centre rather than
  // stacking, and so the note's stem can hang off its head.
  bar: { position: 'absolute', borderRadius: 1 },
  line: { height: 2, borderRadius: 1 },
  noteHead: { position: 'absolute', bottom: '18%', left: '14%', borderRadius: 999 },
  noteStem: { position: 'absolute', bottom: '24%', width: 2, borderRadius: 1 },
  sliderRow: { justifyContent: 'center' },
  sliderTrack: { width: '100%' },
  // Centred on its offset rather than starting at it, so a handle at 100% would
  // still be half on the track instead of hanging off the end.
  sliderHandle: { position: 'absolute', borderRadius: 999, transform: [{ translateX: -5 }] },
})

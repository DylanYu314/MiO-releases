import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pressable, StyleSheet, Switch, Text, View, type LayoutChangeEvent } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'

import {
  equalizerBands,
  isBalanceSupported,
  isMonoSupported,
  isEqualizerSupported,
} from '../../modules/mio-equalizer'
import {
  EQ_PRESETS,
  MAX_GAIN_DB,
  useAudioSettings,
  type EqPresetName,
} from '../player/audioSettings'
import { useEqualizerReach } from '../player/equalizerReach'
import { useTheme, useThemedStyles, type Theme } from '../theme'
import { Button } from '../components/ui/Button'
import { Chip } from '../components/ui/Chip'

const PRESETS = Object.keys(EQ_PRESETS) as EqPresetName[]

/** One press moves a band this far. 2 dB is a step you can hear; 1 dB turns ten
 *  bands into forty taps to get anywhere. */
const STEP_DB = 2

/** Balance is held as −1..1 and drawn on a meter that rounds to whole units, so
 *  it is driven at a hundred: one unit is one percent (#380). */
const BALANCE_SCALE = 100

/** How far a finger must travel sideways before a band drag starts, and how far
 *  down before it gives up and lets the settings page scroll. ADR-018 case 1;
 *  the same pair the progress scrubber uses. */
const GRAB_SLOP = 6
const SCROLL_SLOP = 12

/** Frequencies read better as "16k" than "16000". */
function label(frequency: number): string {
  return frequency >= 1000 ? `${frequency / 1000}k` : String(frequency)
}

/**
 * The gain a touch at `x` means, on a meter `width` wide.
 *
 * Pure, and tested as such, for the reason the scrubber's `secondsAt` and the
 * marquee's `marqueeRun` are: the arithmetic is the part that can be wrong in a
 * way nobody notices, and the gesture around it is the part jest cannot see.
 *
 * The centre of the bar is 0 dB and the ends are ±{@link MAX_GAIN_DB}, so this
 * is the same mapping the bar already draws, read backwards.
 *
 * Rounded to whole decibels. The steppers move in 2 dB because a tap should
 * land somewhere useful; a finger is choosing a position, and 1 dB is about the
 * finest distinction worth keeping — it also means the number under the finger
 * changes as it moves, which is what makes the drag feel connected to anything.
 */
export function gainAt(x: number, width: number, maxGainDb = MAX_GAIN_DB): number {
  if (width <= 0) return 0
  const fraction = Math.min(Math.max(x / width, 0), 1)
  return Math.round((fraction * 2 - 1) * maxGainDb)
}

/**
 * The ten-band equaliser (#202).
 *
 * ## Steppers, not sliders
 *
 * Ten sliders is the web's layout and it needs a slider component, which on
 * React Native is a native module — a second one, on top of the equaliser's
 * own, for a control whose precision nobody wants. A band is a −/+ pair and a
 * number instead: coarser, and the coarseness is honest, because 2 dB is about
 * the smallest step that is audible on a phone.
 *
 * ## Why it can be missing entirely
 *
 * `DynamicsProcessing` is API 28, and the native module only exists in a build
 * made after it was added. Both are checked, and when either fails this says so
 * plainly rather than offering controls that move numbers and change no sound —
 * which would be the worse failure, because it looks like it works.
 *
 * ## Nothing here subscribes to the curve (#372)
 *
 * It used to read `eqGains`, so a moving band re-rendered the panel — all ten
 * rows, their steppers and their labels — and a drag did that on every gesture
 * frame. That is the whole of the "completely local component, this shouldn't
 * happen" lag I measured on the release build; it was never the platform.
 *
 * Each row subscribes to **its own** gain instead, so a band that moves
 * re-renders one row. `preset` stays here because it belongs to the chips, and
 * it changes once per drag (to "Custom") rather than per frame.
 */
export function EqualizerPanel() {
  const { t } = useTranslation()
  const styles = useThemedStyles(makeStyles)
  const theme = useTheme()

  const preset = useAudioSettings((state) => state.preset)
  const applyPreset = useAudioSettings((state) => state.applyPreset)
  const resetEq = useAudioSettings((state) => state.resetEq)
  const reaching = useEqualizerReach((state) => state.reaching)
  const reason = useEqualizerReach((state) => state.reason)

  const supported = isEqualizerSupported()
  // The native side is the authority on which frequencies are actually being
  // filtered, so the labels come from it rather than from a copy that could
  // drift. Falling back to the store's length keeps the panel drawable in a
  // build without the module, for the unsupported message.
  const bands = supported ? equalizerBands() : []

  if (!supported) {
    return (
      <View style={styles.block}>
        <Text style={styles.section}>{t('equalizer.title')}</Text>
        <Text style={styles.unsupportedTitle}>{t('equalizer.unsupportedTitle')}</Text>
        <Text style={styles.description}>{t('equalizer.unsupportedBody')}</Text>
      </View>
    )
  }

  return (
    <View style={styles.block}>
      <Text style={styles.section}>{t('equalizer.title')}</Text>
      {/* Whether the EQ is doing anything at all, said once. A flat curve is
          bit-transparent on the web and inaudible here, so "Equalizer" alone
          does not tell you if it is shaping your sound. */}
      <Text style={styles.description}>
        {preset === 'flat' ? t('equalizer.neutral') : t('equalizer.active')}
      </Text>

      {/*
       * The curve is set and the audio has refused it.
       *
       * `isEqualizerSupported()` above answers "is there a module here"; this
       * answers "did it take", which is a different question and the one that
       * has now been wrong twice on a device. Only shown for false — `null`
       * means nothing is playing, so there is no session to attach to and
       * nothing has been refused.
       */}
      {reaching === false ? (
        <View style={styles.warning}>
          <Text style={styles.warningTitle}>{t('equalizer.notReachingTitle')}</Text>
          <Text style={styles.description}>{t('equalizer.notReachingBody')}</Text>
          {/* The native side's own code, deliberately untranslated. It is for
              whoever is debugging this — the same string appears in the
              diagnostics log — and inventing nine sentences of prose for
              failures a tester cannot act on would bury the one that matters. */}
          {reason ? <Text style={styles.reason}>{reason}</Text> : null}
        </View>
      ) : null}

      <View style={styles.chips}>
        {PRESETS.map((name) => (
          <Chip
            key={name}
            label={t(`equalizer.presets.${name}`)}
            selected={preset === name}
            onPress={() => void applyPreset(name)}
          />
        ))}
        {/* Not pressable: "Custom" is a description of where the curve came
            from, not somewhere you can go. It appears only once a band has been
            moved, which is the only way to reach it. */}
        {preset === null ? (
          <View style={[styles.chip, styles.chipActive]}>
            <Text style={[styles.chipText, styles.chipTextActive]}>
              {t('equalizer.presets.custom')}
            </Text>
          </View>
        ) : null}
      </View>

      {bands.map((frequency, index) => (
        <BandRow
          key={frequency}
          index={index}
          frequency={frequency}
          styles={styles}
          theme={theme}
        />
      ))}

      <Button label={t('equalizer.reset')} variant="plain" onPress={() => void resetEq()} />

      {/*
        Balance, only where the binary can actually do it (#380).

        `isBalanceSupported()` asks about the **function**, not the module: the
        equaliser has existed since #202 and `setBalance` has not, so a build
        made before this one would otherwise be offered a control that moves and
        changes nothing — the exact class of lie iteration v0.5.0 was named for.

        Mono is the same question asked of a different mechanism (#482): it is
        not a `DynamicsProcessing` stage at all — no stage sums channels — but an
        audio processor in ExoPlayer's sink, injected by a config plugin. So it
        has its own gate, and that gate asks whether the *processor* is in the
        binary rather than whether the module is.
      */}
      {isBalanceSupported() ? <BalanceRow styles={styles} theme={theme} /> : null}
      {isMonoSupported() ? <MonoRow styles={styles} theme={theme} /> : null}
    </View>
  )
}

/**
 * Play both channels as their sum (#482).
 *
 * A switch rather than a meter, because it is a state and not an amount — and
 * its own component for the reason `BalanceRow` is: a control that re-renders
 * the whole panel is the shape #372 found behind "too laggy".
 *
 * The hint says what it is *for*. Mono reads like a downgrade unless the reason
 * is on screen: one earbud, or hearing that differs between the ears, where the
 * alternative is losing whatever was mixed to the other side entirely.
 */
function MonoRow({ styles, theme }: { styles: ReturnType<typeof makeStyles>; theme: Theme }) {
  const { t } = useTranslation()
  const mono = useAudioSettings((state) => state.mono)
  const setMono = useAudioSettings((state) => state.setMono)

  return (
    <View style={styles.block}>
      <Text style={styles.section}>{t('equalizer.channelMode')}</Text>
      <View style={styles.monoRow}>
        <View style={styles.monoLabel}>
          <Text style={styles.monoTitle}>{t('equalizer.mono')}</Text>
          <Text style={styles.monoHint}>{t('equalizer.monoHint')}</Text>
        </View>
        <Switch
          value={mono}
          onValueChange={(next) => void setMono(next)}
          accessibilityLabel={t('equalizer.mono')}
          trackColor={{ false: theme.border, true: theme.accent[4] }}
          thumbColor={mono ? theme.accentSolid : theme.surfaceMuted}
        />
      </View>
    </View>
  )
}

/**
 * Left/right balance, drawn with the band meter at a hundredth of its scale.
 *
 * Its own component so it carries its own subscription: #372's whole finding
 * was that a control which re-renders the panel on every gesture frame is a
 * design error rather than a platform cost, and a balance drag is exactly that
 * shape.
 */
function BalanceRow({ styles, theme }: { styles: ReturnType<typeof makeStyles>; theme: Theme }) {
  const { t } = useTranslation()
  const balance = useAudioSettings((state) => state.balance)
  const previewBalance = useAudioSettings((state) => state.previewBalance)
  const setBalance = useAudioSettings((state) => state.setBalance)

  // The same three phrasings the web uses, from the same catalogue keys, so the
  // two clients cannot describe the same position differently.
  const readout =
    balance === 0
      ? t('equalizer.balanceCentre')
      : balance < 0
        ? t('equalizer.balanceLeft', { percent: Math.round(-balance * 100) })
        : t('equalizer.balanceRight', { percent: Math.round(balance * 100) })

  return (
    <View style={styles.block}>
      <Text style={styles.section}>{t('equalizer.balance')}</Text>
      <View style={styles.bandRow}>
        <BandMeter
          index={0}
          testId="balance"
          max={BALANCE_SCALE}
          // Whole percent in, a fraction out: `gainAt` rounds to whole units,
          // so working at a hundred gives a 1% step for free.
          gain={Math.round(balance * BALANCE_SCALE)}
          styles={styles}
          theme={theme}
          onPreview={(percent) => previewBalance(percent / BALANCE_SCALE)}
          onCommit={() => void setBalance(useAudioSettings.getState().balance)}
        />
        <Text style={styles.gainText}>{readout}</Text>
      </View>
      {/* Only once it is off centre. A permanently visible "reset" on a control
          that is already at its default is a dead press, and its appearing is
          itself the signal that the balance has been moved — which matters on a
          panel you scroll past. The EQ's own reset is always shown because a
          flat curve and a moved one are much harder to tell apart at a glance. */}
      {balance === 0 ? null : (
        <Button
          label={t('equalizer.balanceReset')}
          variant="plain"
          onPress={() => void setBalance(0)}
        />
      )}
    </View>
  )
}

/**
 * One band: a label, two steppers, the bar and the number.
 *
 * Its own component so that it can hold its own subscription — `eqGains[index]`
 * rather than `eqGains` — which is what keeps a band moving from re-rendering
 * the other nine (#372). Zustand compares the selector's result with `Object.is`,
 * and this one is a number, so a row whose gain did not change does not render.
 */
function BandRow({
  index,
  frequency,
  styles,
  theme,
}: {
  index: number
  frequency: number
  styles: ReturnType<typeof makeStyles>
  theme: Theme
}) {
  const { t } = useTranslation()
  const gain = useAudioSettings((state) => state.eqGains[index] ?? 0)
  const setBandGain = useAudioSettings((state) => state.setBandGain)
  const previewBandGain = useAudioSettings((state) => state.previewBandGain)
  const commitBandGains = useAudioSettings((state) => state.commitBandGains)

  return (
    <View style={styles.bandRow}>
      <Text style={styles.bandLabel}>{label(frequency)}</Text>
      <Pressable
        onPress={() => void setBandGain(index, gain - STEP_DB)}
        disabled={gain <= -MAX_GAIN_DB}
        accessibilityRole="button"
        accessibilityLabel={t('equalizer.bandDown', { frequency: label(frequency) })}
        hitSlop={6}
        style={({ pressed }) => [
          styles.step,
          gain <= -MAX_GAIN_DB && styles.stepDisabled,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.stepText}>{'−'}</Text>
      </Pressable>

      {/* A bar as well as a number: ten rows of digits is a table, and the shape
          of a curve is the thing being read — and since #317 it is also the
          control. */}
      <BandMeter
        index={index}
        gain={gain}
        styles={styles}
        theme={theme}
        onPreview={(value) => previewBandGain(index, value)}
        onCommit={() => void commitBandGains()}
      />

      <Pressable
        onPress={() => void setBandGain(index, gain + STEP_DB)}
        disabled={gain >= MAX_GAIN_DB}
        accessibilityRole="button"
        accessibilityLabel={t('equalizer.bandUp', { frequency: label(frequency) })}
        hitSlop={6}
        style={({ pressed }) => [
          styles.step,
          gain >= MAX_GAIN_DB && styles.stepDisabled,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.stepText}>{'+'}</Text>
      </Pressable>

      <Text style={styles.gainText}>{t('equalizer.decibels', { value: gain })}</Text>
    </View>
  )
}

/**
 * One band's bar, which is also its control (#317).
 *
 * ## A drag, and no native slider
 *
 * The steppers were chosen to avoid `@react-native-community/slider` — a native
 * module, and therefore a build. `ADR-018` answers this without one: a
 * horizontal control inside a vertical `ScrollView` claims its own axis with
 * `activeOffsetX` and yields the other, so the settings page still scrolls
 * normally when a finger moves down the screen.
 *
 * That makes "needs a native module" wrong for the third time in this repo,
 * after #241's sleep fade and #201's crossfade.
 *
 * ## The steppers stay
 *
 * They are the accessible path — a −/+ pair has a label a screen reader can
 * read and a target that does not require aiming — and #317 asked for the drag
 * *alongside* them, not instead. They are also the only way to be exact.
 *
 * ## What #372 actually costs, and what it does not (rewritten after the crash)
 *
 * The lag was never the gesture. It was that the pan wrote a store the **whole
 * panel** subscribed to on every frame, so one dot moving re-rendered ten bands
 * sixty times a second. Two things fix that and neither needs the UI thread:
 *
 * 1. **A gain is a whole number of decibels**, so most frames of a drag mean
 *    nothing. The gesture only tells React when the *rounded* value changes — at
 *    most twenty-five times across the whole bar, usually a handful.
 * 2. **Each row subscribes to its own gain**, so the update that does happen
 *    re-renders one row rather than ten.
 *
 * The store write stays mid-drag on purpose: `PlayerHost` re-applies the curve
 * when `eqGains` changes, and #317 wanted a drag you can *hear*.
 *
 * ## Why this is `.runOnJS(true)` again, having moved off it
 *
 * #372's first version also drove the bar from a shared value through
 * `useAnimatedStyle`, to move the dot on the UI thread between decibels. **That
 * build crashed the app on the first drag, natively, with nothing in the
 * diagnostics log** (2026-08-09) — and `diagnostics/log.ts` says why an empty
 * log points at a native fault: `persist` writes asynchronously.
 *
 * It was the only animated style in this app returning **percentage strings**.
 * Every other one — `DraggableList`, `SwipeableRow`, `MarqueeText` — returns
 * numbers, and none of them crashes. Reanimated's own source only converts `%`
 * in its CSS and SVG subsystems and for `transformOrigin`; an ordinary
 * `useAnimatedStyle` hands `left: "37.5%"` to `updateProps` untouched.
 *
 * That is a strong correlation and not a proof, and a proof needs a device. So
 * this takes the option that needs neither: **the animated style is gone**, the
 * bar is drawn by React from ordinary styles — where percentages are RN's own
 * feature and have always worked — and the drag keeps both of the wins above.
 * The dot moves in decibel steps rather than continuously, which is what a
 * control with an integer readout is anyway.
 *
 * If a continuous dot is ever worth having, it is a **numeric `translateX`**,
 * the shape the three working components use. Not percentages.
 */
function BandMeter({
  index,
  gain,
  styles,
  theme,
  onPreview,
  onCommit,
  max = MAX_GAIN_DB,
  testId = `band-${index}`,
}: {
  index: number
  gain: number
  styles: ReturnType<typeof makeStyles>
  theme: Theme
  /** When the finger crosses into a new decibel: memory only, no disk. */
  onPreview: (gain: number) => void
  /** Once it lifts: write it down. */
  onCommit: () => void
  /**
   * The value at each end, defaulting to the equaliser's ±12 dB (#380).
   *
   * Balance reuses this control at `max = 100` and divides by a hundred, so the
   * quantisation `gainAt` already does — rounding to whole units — becomes
   * whole percent. One centre-anchored meter for both, rather than a second
   * copy of a drag this project has already had to revert once (#410).
   */
  max?: number
  testId?: string
}) {
  const [width, setWidth] = useState(0)

  /** Tell React, but only when the decibel under the finger is a new one. That
   *  gate is the whole of the frame cost: a finger moving within one decibel is
   *  saying nothing new, and used to re-render ten rows for saying it. */
  const report = (next: number) => {
    if (next === gain) return
    onPreview(next)
  }

  const pan = Gesture.Pan()
    .withTestId(testId)
    .runOnJS(true)
    .maxPointers(1)
    // Claim sideways movement only, so a finger travelling down the settings
    // page scrolls it rather than dragging whichever band it started on.
    .activeOffsetX([-GRAB_SLOP, GRAB_SLOP])
    .failOffsetY([-SCROLL_SLOP, SCROLL_SLOP])
    /*
     * Compared against **this render's** `gain`, not a ref holding the last
     * value sent — ADR-018 case 5. `GestureDetector` re-attaches its handlers on
     * every render, so a gesture built now sees now's value; a ref would be the
     * same thing with a lint error and a stale-closure trap attached.
     *
     * That the comparison works at all is the row's own subscription doing its
     * job: `onPreview` writes the store, this row re-renders with the new
     * `gain`, and the next frame is compared against it.
     */
    .onStart((event) => report(gainAt(event.x, width, max)))
    .onUpdate((event) => report(gainAt(event.x, width, max)))
    // Saved when the finger lifts, and on a cancelled drag too: the bands have
    // already moved and the audio already changed, so the only question left is
    // whether it survives a restart.
    .onFinalize(() => onCommit())

  return (
    <GestureDetector gesture={pan}>
      <View
        testID="band-meter"
        style={styles.meter}
        onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
      >
        <View style={styles.meterCentre} />
        <View
          style={[
            styles.meterFill,
            gain >= 0
              ? { left: '50%', width: `${(gain / max) * 50}%` }
              : { right: '50%', width: `${(-gain / max) * 50}%` },
            { backgroundColor: gain === 0 ? theme.border : theme.accentSolid },
          ]}
        />
        {/* The dot says the bar is a control (#317). Without it this is a
            readout that happens to respond to a finger, which is the same
            complaint the drag handle answered for the queue. */}
        <View
          testID="band-thumb"
          style={[styles.meterThumb, { left: `${(gain / max) * 50 + 50}%` as const }]}
        />
      </View>
    </GestureDetector>
  )
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    /** The one shared press fill (#378). */
    pressed: { backgroundColor: theme.surfacePressed },
    block: { gap: 8 },
    /** The switch and its label, which is a row rather than a stack — the
     *  settings screen's own shape for a toggle with an explanation. */
    monoRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    monoLabel: { flex: 1, minWidth: 0, gap: 2 },
    monoTitle: { fontSize: 14, color: theme.text },
    monoHint: { fontSize: 12, color: theme.textMuted, lineHeight: 17 },
    section: { fontSize: 13, fontWeight: '600', color: theme.textMuted, marginTop: 24 },
    description: { fontSize: 13, color: theme.textMuted, lineHeight: 18 },
    unsupportedTitle: { fontSize: 15, fontWeight: '500', color: theme.text },
    // Bordered rather than coloured in: this is a statement of fact about the
    // build, not an error the user has caused or can act on from here.
    warning: {
      gap: 4,
      padding: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.surfaceMuted,
    },
    warningTitle: { fontSize: 14, fontWeight: '600', color: theme.text },
    reason: { fontSize: 12, fontFamily: 'monospace', color: theme.textMuted, marginTop: 4 },
    chips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginTop: 4 },
    chip: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.border,
    },
    chipActive: { backgroundColor: theme.accentSolid, borderColor: theme.accentSolid },
    chipText: { fontSize: 13, color: theme.text },
    chipTextActive: { color: theme.accentText, fontWeight: '600' },
    bandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    bandLabel: { width: 40, fontSize: 12, color: theme.textMuted },
    step: {
      width: 32,
      height: 32,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepDisabled: { opacity: 0.35 },
    stepText: { fontSize: 16, color: theme.text, lineHeight: 20 },
    meter: {
      flex: 1,
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.surfaceMuted,
      justifyContent: 'center',
    },
    meterCentre: {
      position: 'absolute',
      left: '50%',
      width: StyleSheet.hairlineWidth,
      height: 8,
      backgroundColor: theme.border,
    },
    meterFill: { position: 'absolute', height: 4, borderRadius: 2 },
    meterThumb: {
      position: 'absolute',
      width: 14,
      height: 14,
      borderRadius: 999,
      backgroundColor: theme.accentSolid,
      // Centred on its position rather than starting at it, so it sits over the
      // value it reports at both ends — the same correction the scrubber's
      // thumb needs.
      transform: [{ translateX: -7 }],
    },
    gainText: { width: 52, fontSize: 12, color: theme.textMuted, textAlign: 'right' },
  })

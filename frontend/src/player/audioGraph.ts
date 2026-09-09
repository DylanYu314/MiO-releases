/**
 * The Web Audio processing graph — ADR-012.
 *
 *   deckA -> sourceA -> normGainA -> fadeGainA \
 *                                              -> master -> destination
 *   deckB -> sourceB -> normGainB -> fadeGainB /
 *
 * G1 shipped a single shared `fadeGain`, which cannot express a crossfade:
 * blending two decks needs a gain each, moving in opposite directions. G2 split
 * it — `fadeGainA`/`fadeGainB` are the crossfade stage, and `master` is the one
 * point EQ and mono/balance (G3) will insert before. Loudness normalization
 * (G4) drives `normGainA`/`normGainB`, which is why crossfade does not borrow
 * those: two features must not fight over one AudioParam.
 *
 * With crossfade off, deck A sits at unity and deck B at zero, so the signal
 * path is exactly what G1 measured — a chain of unity gains, transparent to
 * +0.044 dB against the source file.
 *
 * Volume and mute deliberately stay on the <audio> element rather than moving
 * to a GainNode. An element routed through a MediaElementAudioSourceNode still
 * honours both, and applying volume at the element *and* at a gain node
 * multiplies them — 0.5 becomes 0.25, which is plainly audible. Measured, not
 * assumed; see ADR-012.
 *
 * Imperative and outside the store on purpose: the store stays pure (ADR-003),
 * exactly as `useAudioElement` already keeps the element out of it.
 */

/**
 * Ten octave-spaced bands, the standard graphic-EQ layout. Shared by the graph
 * and the UI so a slider can never drift from the filter it drives.
 */
export const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const

/** Boost/cut limit per band, in dB. */
export const EQ_MAX_GAIN_DB = 12

/** One octave of bandwidth for the peaking filters between the two shelves. */
const EQ_PEAKING_Q = 1.41

export type ChannelMode = 'stereo' | 'mono'

export interface AudioGraph {
  readonly context: AudioContext
  /** The element React renders and binds. Active on load; the crossfade swaps
   *  which deck is active from then on. */
  readonly deckA: HTMLAudioElement
  /** Created imperatively, silent until a crossfade plays into it. */
  readonly deckB: HTMLAudioElement
  /** Reserved for G4's loudness normalization; unity for now. */
  readonly normGainA: GainNode
  readonly normGainB: GainNode
  /** The crossfade stage: one gain per deck, ramped in opposite directions.
   *  A starts open, B closed. */
  readonly fadeGainA: GainNode
  readonly fadeGainB: GainNode
  /** Single summing point, ahead of the processing chain. */
  readonly master: GainNode
  /** Ten filters in series, one per band of EQ_BANDS. At 0 dB each is
   *  mathematically unity, so a flat EQ is bit-transparent — measured. */
  readonly eq: readonly BiquadFilterNode[]
  /** Doubles as the mono downmixer: `channelCount = 1` makes the spec's own
   *  speaker downmix produce (L+R)/2, which is one node instead of a
   *  splitter/merger lattice. */
  readonly channelMix: GainNode
  /** Balance. Transparent at pan 0 for stereo input, by the spec's own
   *  formula — verified. */
  readonly panner: StereoPannerNode
  /**
   * Browsers start a context suspended, and a suspended context wired to the
   * destination produces *silence behind a moving progress bar* — the worst
   * failure available here, because everything looks right. Called from the
   * play path, which is the user gesture the autoplay policy wants.
   */
  resume: () => void
}

type AudioContextCtor = new () => AudioContext

/**
 * The context and its element bindings last for the page's lifetime.
 * `createMediaElementSource` binds an element permanently: calling it twice on
 * one element throws `InvalidStateError`, and so does binding that element to a
 * *second* context (both verified in Chromium). A context that is closed can
 * therefore never have its decks reattached — the audio path would be dead for
 * the rest of the session with no way back. Hence a module singleton, no
 * teardown, and no "recreate on error" retry.
 */
let graph: AudioGraph | null = null

/** Latched once the environment proves it can't do Web Audio, so we don't retry
 *  the construction on every render. */
let unsupported = false

function contextConstructor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null
  const candidate = window as Window & {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  return candidate.AudioContext ?? candidate.webkitAudioContext ?? null
}

/**
 * The graph for this page, building it on first use.
 *
 * Returns `null` when Web Audio is unavailable or the graph can't be built, and
 * the caller then plays the element directly — the same path the app used
 * before this slice. That fallback is the point: introducing the graph must not
 * make playback itself newly fragile.
 */
export function getAudioGraph(deckA: HTMLAudioElement): AudioGraph | null {
  if (unsupported) return null

  if (graph) {
    // A bound element can never be re-pointed. If React ever hands over a
    // different element, degrade to direct playback rather than drive a deck
    // that is no longer in the document.
    return graph.deckA === deckA ? graph : null
  }

  const Ctor = contextConstructor()
  if (!Ctor) {
    unsupported = true
    return null
  }

  try {
    const context = new Ctor()

    const deckB = document.createElement('audio')
    deckB.hidden = true
    deckB.preload = 'auto'

    const normGainA = context.createGain()
    const normGainB = context.createGain()
    const fadeGainA = context.createGain()
    const fadeGainB = context.createGain()
    const master = context.createGain()
    // Explicit rather than relying on the 1.0 default: which stages are
    // pass-throughs is the whole contract here.
    normGainA.gain.value = 1
    normGainB.gain.value = 1
    master.gain.value = 1
    // Deck A carries playback until the first crossfade; deck B must be silent
    // or its preloaded track would be audible underneath.
    fadeGainA.gain.value = 1
    fadeGainB.gain.value = 0

    // The processing chain (G3): ten EQ bands, then channel mode, then balance.
    // Every stage is built at its neutral setting, and the whole chain measures
    // bit-identical to no chain at all in that state.
    const eq = EQ_BANDS.map((frequency, index) => {
      const filter = context.createBiquadFilter()
      // Shelves at the ends, peaks between: a boost at 31 Hz should lift
      // everything below it, not just a bump around 31.
      filter.type =
        index === 0 ? 'lowshelf' : index === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking'
      filter.frequency.value = frequency
      if (filter.type === 'peaking') filter.Q.value = EQ_PEAKING_Q
      filter.gain.value = 0
      return filter
    })

    const channelMix = context.createGain()
    channelMix.channelCountMode = 'explicit'
    channelMix.channelInterpretation = 'speakers'
    channelMix.channelCount = 2

    const panner = context.createStereoPanner()
    panner.pan.value = 0

    context.createMediaElementSource(deckA).connect(normGainA)
    context.createMediaElementSource(deckB).connect(normGainB)
    normGainA.connect(fadeGainA)
    normGainB.connect(fadeGainB)
    fadeGainA.connect(master)
    fadeGainB.connect(master)

    let tail: AudioNode = master
    for (const filter of eq) tail = tail.connect(filter)
    tail.connect(channelMix).connect(panner).connect(context.destination)

    graph = {
      context,
      deckA,
      deckB,
      normGainA,
      normGainB,
      fadeGainA,
      fadeGainB,
      master,
      eq,
      channelMix,
      panner,
      resume: () => {
        if (context.state === 'suspended') void context.resume()
      },
    }
    return graph
  } catch {
    // A browser that has AudioContext but refuses to build the graph — an
    // already-bound element, a blocked context — must not take playback down
    // with it.
    unsupported = true
    return null
  }
}

/** Samples per fade curve — inaudibly smooth across any duration the slider
 *  offers, and trivial to build. Odd on purpose, so one sample lands exactly on
 *  the halfway point where the two curves should cross at √½. */
const FADE_CURVE_STEPS = 65

/**
 * Freeze an automation at whatever value it currently holds.
 *
 * `cancelAndHoldAtTime` exists for exactly this; without it, interrupting a
 * fade reverts the parameter to the value scheduled *before* the fade began,
 * which is an audible click. Not in every engine, so fall back to a plain
 * cancel.
 */
function holdCurrentValue(param: AudioParam, at: number): number {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    param.cancelAndHoldAtTime(at)
  } else {
    param.cancelScheduledValues(at)
  }
  return param.value
}

/**
 * Schedule one half of an equal-power crossfade.
 *
 * Linear ramps are the wrong shape for blending two *different* tracks:
 * uncorrelated signals sum in power, not amplitude, so two linear ramps
 * crossing at 0.5 give a combined level of √(0.5² + 0.5²) ≈ 0.707 — a 3 dB dip
 * in the middle of every transition, heard as a lull rather than a blend.
 *
 * cos/sin quarter-waves hold `out² + in² = 1` for the whole fade, so the
 * perceived loudness stays constant. The curve starts from the parameter's
 * current value rather than a fixed 1 or 0, so interrupting a fade in progress
 * (hitting next mid-crossfade) stays continuous.
 */
export function scheduleEqualPowerFade(
  param: AudioParam,
  direction: 'in' | 'out',
  startTime: number,
  duration: number,
): Float32Array {
  const from = holdCurrentValue(param, startTime)
  const curve = new Float32Array(FADE_CURVE_STEPS)

  for (let index = 0; index < FADE_CURVE_STEPS; index++) {
    const position = index / (FADE_CURVE_STEPS - 1)
    const quarterTurn = (position * Math.PI) / 2
    curve[index] =
      direction === 'out' ? from * Math.cos(quarterTurn) : from + (1 - from) * Math.sin(quarterTurn)
  }

  param.setValueCurveAtTime(curve, startTime, duration)
  return curve
}

export interface AudioProcessing {
  /** Per-band gain in dB, one entry per EQ_BANDS frequency. */
  eqGains: readonly number[]
  channelMode: ChannelMode
  /** -1 hard left, 0 centred, 1 hard right. */
  balance: number
}

/**
 * Push the processing settings onto the graph.
 *
 * Values are assigned directly rather than ramped: these are deliberate
 * adjustments the listener is making while hearing the result, so they should
 * take effect immediately. (Crossfade ramps because it is automatic and
 * continuous; this is neither.)
 */
export function applyAudioProcessing(graph: AudioGraph, settings: AudioProcessing): void {
  graph.eq.forEach((filter, index) => {
    const gain = settings.eqGains[index] ?? 0
    filter.gain.value = Math.min(Math.max(gain, -EQ_MAX_GAIN_DB), EQ_MAX_GAIN_DB)
  })

  // 1 makes the spec downmix stereo to (L+R)/2; 2 passes it through untouched.
  graph.channelMix.channelCount = settings.channelMode === 'mono' ? 1 : 2
  graph.panner.pan.value = Math.min(Math.max(settings.balance, -1), 1)
}

/** Test seam. The singleton is page-lifetime by design, so tests need a way to
 *  start clean; nothing in the app calls this. */
export function resetAudioGraphForTests(): void {
  graph = null
  unsupported = false
}

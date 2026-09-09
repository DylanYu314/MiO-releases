# ADR-018 — How a gesture composes with a scroll view

## Status

Accepted — 2026-08-05.

Numbered 18 rather than 17: **ADR-017 was already reserved** — and it names
`docs/adr/0017-*.md` in its own description — for deleting the server's copy of
the audio once a device confirms it holds it. That decision has not been written
yet, and taking its number would have made the issue point at the wrong file.

## Context

Three of the four defects in the progress-bar report were not really about the
progress bar. They
were about **two things wanting the same finger**: the scrubber, and the
`ScrollView` the playing panel is built out of. The same question is asked again
three more times in the same iteration — swipe a row to enqueue, drag the context
queue, drag an EQ slider — and once more by the drag-to-reorder
list that already exists. It is worth answering once.

### The two systems, and why only one of them can win

React Native ships a **responder system**: on a touch, views bid to become "the
responder", and one of them wins. `PanResponder` is the JS wrapper around it,
and it is what the scrubber used.

Its problem is that responsibility can be *taken back*. A responder is asked
`onPanResponderTerminationRequest` when something else wants the touch, and the
default answer is **yes**. `ScrollView` asks, constantly. So a drag that had
started perfectly well would be handed to the scroll view part-way through — and
the scrubber's terminate handler committed a seek at whatever partial position
the finger had reached by then. That is the reported "it jumps to a random
position",
and holding still for a moment before dragging was the user working out how to
stop the scroll view claiming the touch.

`react-native-gesture-handler` is the other system. Its handlers live in native
code inside `GestureHandlerRootView`, and when one **activates** it cancels the
competing native touch stream instead of negotiating with it (on Android, via
`requestDisallowInterceptTouchEvent` on the parents). A scroll view cannot take
an activated pan away. That inversion is the whole reason the library exists,
and it was already available here: gesture-handler, Reanimated and worklets have
been pinned and proved since the drag list was written, and `DraggableList` is
built on them.

So the question is never "how do I stop the scroll view stealing my gesture". It
is **"under what condition should my gesture activate"** — because before
activation the scroll view has the touch, and after activation it cannot get it
back.

## Decision

**Separate the two by whichever of axis, time or discreteness actually
distinguishes them, and always use gesture-handler to do it.**

### 1. Different axis → `activeOffsetX` / `failOffsetY`

For a horizontal control inside a vertical scroll view — the progress bar, and
the EQ sliders:

```ts
Gesture.Pan()
  .activeOffsetX([-6, 6])   // only ever activates sideways
  .failOffsetY([-12, 12])   // and gives up early if the finger goes down
```

`activeOffsetX` means a vertical drag *never* activates the pan, so it scrolls
the panel as though the control were not there. `failOffsetY` is not redundant:
without it both sit undecided while the finger moves, and the scroll starts
late. The downward figure is the larger one because a sideways drag by a thumb
is an arc, not a line.

Once the pan is active neither offset is consulted again (Android's
`PanGestureHandler.onHandle` only tests them in `STATE_BEGAN`), so a scrub
cannot be cancelled by drifting vertically mid-drag. That is the property
`PanResponder` could not offer at all.

### 2. Same axis → separate by time, with `activateAfterLongPress`

A vertical drag inside a vertical list — `DraggableList`, and the queue —
cannot be told apart by direction, so it is told apart by intent: hold still
first. `.activateAfterLongPress(120)` is already what that list does, and the
120 ms figure is mine, measured on a device.

**Reuse the list, do not re-tune it per screen.** One constant drives both
screens that use it.

### 3. A tap is a different gesture, and must be raced

A pan cannot see a tap. On Android, `PanGestureHandler` only evaluates
activation on the *second* motion event of a touch, so an `ACTION_UP` while the
handler is still `BEGAN` calls `fail()` — even with `minDistance(0)`. Real
fingers usually jitter enough to activate, which makes this look like it works
until it does not.

So anything that must answer a still tap composes two gestures:

```ts
Gesture.Race(tap, pan)
```

`Race` means the first to activate wins and the other is cancelled: movement
activates the pan, a still release activates the tap. This is what made "tapping
the bar" work at all.

### 4. Callbacks may be plain JS — say so with `.runOnJS(true)`

Gesture callbacks are worklets by default and run on the UI thread, which is
right when the response is a Reanimated animation (`DraggableList` moves rows
that way, and reaches JS through `runOnJS`). When the response is React state or
a store write there is nothing for the UI thread to do that it would not
immediately hand back, and `.runOnJS(true)` says so directly.

### 5. Do not keep values in refs for the handlers to read

`PanResponder.create` captures its handlers **once**, which is why the old
scrubber kept `width` and `duration` in a ref and explained at length why: a
handler built on the first render closes over `duration: 0` and seeks to the
start of the track forever.

`GestureDetector` re-attaches on every render — `updateHandlers.ts` assigns
`handler.handlers = newGestures[i].handlers`, and `eventReceiver.ts` reads
`handler.handlers` at dispatch time — so a gesture rebuilt each render sees that
render's values. The refs and their explanations go away.

The swap happens on a `setImmediate` (`ghQueueMicrotask`), which is invisible
next to a finger but visible to a test that installs jest's fake timers before
the component has laid out.

## Consequences

- **A control that claims an axis is not scrollable by that axis.** Dragging
  sideways on the progress bar will never scroll the panel. That matches every
  other music player and is the intended trade.
- **`PanResponder` is not to be used for anything new here.** It cannot refuse
  to yield mid-gesture without `onPanResponderTerminationRequest` plumbing, and
  every gesture in this app has a scroll view somewhere above it.
- **Tests drive gestures with `fireGestureHandler`**, not by synthesising touch
  events. The old scrubber test had to invent `locationX` — the exact value the
  component was reading wrongly — so it stayed green while the feature was
  broken. One limit worth knowing: `fireGestureHandler` always *completes* a
  gesture, so "the finger is still down" has to be driven through the handler's
  own callbacks.
- **Whether the EQ slider needs a native slider is now answered: no.** It is
  case 1, the same as the progress bar. That keeps S8's native build to what is
  already there ("needs a native module" has been wrong twice: the sleep fade and
  crossfade both turned out not to).

## Related

- ADR-015 — Android app architecture (why this is Expo and gesture-handler is
  present at all).
- The four progress-bar defects this came out of, and `DraggableList`, case 2.
- `mobile/src/components/ProgressScrubber.tsx` — cases 1, 3, 4 and 5 in one
  file, with the reasoning inline.

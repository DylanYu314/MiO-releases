# ADR-011: A two-tier playback queue

## Status

Accepted (2026-07-24). Implemented in Enhancement Track 2, slice E1.

## Context

The player kept **one flat list**: `queue` (already shuffled), `sourceQueue`
(the unshuffled original) and an `index` pointer. `playQueue(songs, start)`
replaced all three.

That single assignment is the bug. Queue three tracks by hand from the library,
then click a song in a playlist, and the three vanish — `playQueue` overwrote
the list they were in. There was also no way to *see* the queue at all, so the
loss was invisible until the wrong song played.

Every mainstream player solves this the same way, and users arrive expecting it:
a manually-built queue is a promise, and starting a different album must not
break it.

A second, smaller problem: shuffle rewrote `queue` in place and kept
`sourceQueue` to undo it. Two parallel arrays that must stay in sync is the kind
of invariant that quietly rots — `removeFromQueue` already had to filter both by
object identity.

## Decision

Playback runs on **two tiers**.

- The **context queue** is whatever list you started playing — a playlist, a
  page of the library, search results. Playing something else replaces it
  wholesale. It carries a `context` descriptor (`kind`, `id`, `name`) so the UI
  can say *"Next from: Road Trip"*.
- The **user queue** is what you added by hand. It always plays first, and
  **nothing replaces it**. Entries are consumed as they play.

```
context:      { kind: 'library'|'playlist'|'search', id?, name? }
contextQueue: Song[]     // the list, in its own order
contextOrder: number[]   // permutation of indices into contextQueue
contextIndex: number     // position within contextOrder; -1 before it starts
userQueue:    Song[]     // manual, survives everything
current:      { source: 'user'|'context', song: Song } | null
```

Rules:

- `playFromContext()` replaces the context and the current track, and **never
  touches `userQueue`**.
- `next()` drains `userQueue` first, then advances `contextIndex`. The context
  pointer does not move while a user-queue entry plays, so the context resumes
  exactly where it left off.
- `addToQueue()` appends; `playNext()` unshifts.
- Shuffle permutes `contextOrder` only. `repeat: 'one'` restarts whatever is
  current, from either tier; `repeat: 'all'` wraps the context.

Three consequences are worth naming because they were choices, not accidents:

**`contextOrder` is a permutation, not a reordered copy.** Shuffling rearranges
indices and leaves `contextQueue` untouched, so turning shuffle off is just
restoring the identity order — no second array to keep in sync. Turning shuffle
*on* only shuffles positions after the pointer, so history isn't replayed and
the current track keeps playing.

**`current` is stored, not derived.** A user-queue entry is removed from the
queue the moment it starts playing, so there is no index that still points at
it. Storing `{ source, song }` also lets the UI distinguish "playing from your
queue" from "playing from the playlist".

**`previous()` from a user-queue track restarts it** rather than jumping into
the context. A consumed entry cannot be un-consumed, and silently landing
somewhere else in the playlist would be worse than the obvious behaviour.

## Consequences

- The persisted shape changed, so `PERSIST_VERSION` goes 1 → 2 with a real
  `migrate` branch: the old `sourceQueue` becomes `contextQueue`, the track
  under the old `index` becomes `current`, and `userQueue` starts empty. Nobody's
  saved queue is dropped by the upgrade — there are tests for this, including
  the case where v1's `queue` was shuffled and `sourceQueue` held the true order.
- Callers changed from `playQueue(songs, i)` to
  `playFromContext(songs, i, context)`. Passing the context is what makes the
  queue panel able to name its source; it is optional, and omitting it just
  leaves the panel's heading generic.
- `PlayerBar` can no longer decide whether "next" is available from
  `index >= queue.length - 1`, because a user-queue entry counts too. That moved
  into a `selectHasNext` selector.
- Queueing with **nothing playing** promotes the song straight to `current`
  rather than putting it in an invisible queue behind an empty player. This
  matches the old behaviour (the song appeared in the bar, paused) and keeps the
  button from looking broken.
- The store stays pure — no DOM, no `<audio>` — per ADR-003, so all of the above
  is unit-testable. E1 ships 40+ store tests covering both tiers, the
  interaction between them, and the migration.
- Still open, by design: the queue **panel** (viewing, reordering, removing) is
  slice E2. This ADR only covers the model. `removeFromUserQueue`,
  `removeFromContextQueue` and `clearUserQueue` exist here so E2 is pure UI.

## Related

- ADR-003 (frontend architecture) — why the player store is Zustand and pure.
- The queue work: this decision, and the panel that followed it.

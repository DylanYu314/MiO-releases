import AsyncStorage from '@react-native-async-storage/async-storage'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native'

import { OnboardingOverlay } from '../src/components/OnboardingOverlay'
import i18n from '../src/i18n'
import { shouldShowHint, shouldShowTour, useOnboarding } from '../src/onboarding/store'

/** Presses of "Next" needed to reach the last step. */
const STEPS_AFTER_FIRST = 4

/**
 * The first-run tour (#323).
 *
 * A port of the web's overlay, so the steps and copy are not the interesting
 * part — they are shared. What is worth pinning is the half the web does not
 * have: `persist` reads AsyncStorage **asynchronously**, so `completed` is
 * `false` for the first frames of every launch and a naive port shows the tour
 * to someone who finished it months ago.
 */

beforeEach(async () => {
  await AsyncStorage.clear()
  await i18n.changeLanguage('en')
  useOnboarding.setState({ completed: false, hydrated: false, dismissedHints: {} })
})

describe('the store', () => {
  it('does not claim to be hydrated before storage has answered', () => {
    // `completed: false` while `hydrated: false` means "do not know", not "not
    // completed" — the distinction the web never has to make.
    expect(useOnboarding.getState().hydrated).toBe(false)
  })

  it('reports hydrated once rehydration runs, even with nothing stored', async () => {
    // A first-ever launch has nothing to read. A flag set only on a successful
    // read would leave that case waiting forever and never show the tour.
    await act(async () => {
      await useOnboarding.persist.rehydrate()
    })

    expect(useOnboarding.getState().hydrated).toBe(true)
  })

  it('picks up a completed tour from storage, so a second launch is quiet', async () => {
    /*
     * Storage is seeded directly rather than by calling `complete()` and then
     * resetting the store, which is what this test did first and why it failed.
     * `persist` subscribes to **every** state change, so the line resetting the
     * store to `completed: false` wrote that to AsyncStorage too — the rehydrate
     * then faithfully read back the value the test had just clobbered.
     *
     * Seeding is also the more honest simulation: this is a real second launch,
     * reading what a previous run left behind.
     */
    await AsyncStorage.setItem(
      'mio-onboarding',
      JSON.stringify({ state: { completed: true }, version: 1 }),
    )

    await act(async () => {
      await useOnboarding.persist.rehydrate()
    })

    expect(useOnboarding.getState().completed).toBe(true)
    expect(useOnboarding.getState().hydrated).toBe(true)
  })

  it('does not persist the hydration flag', async () => {
    await act(async () => {
      useOnboarding.getState().complete()
    })

    const stored = JSON.parse((await AsyncStorage.getItem('mio-onboarding')) ?? '{}')
    // Persisting it would write `true` and read it back on the next launch
    // *before* the read had happened — the exact bug the flag exists to stop.
    expect(stored.state).toEqual({ completed: true, dismissedHints: {} })
  })

  it('re-arms when replayed from Settings', async () => {
    await act(async () => {
      useOnboarding.getState().complete()
    })

    await act(async () => {
      useOnboarding.getState().reset()
    })

    expect(useOnboarding.getState().completed).toBe(false)
  })
})

describe('when the tour is shown', () => {
  it('is not shown before storage has answered', () => {
    // The whole reason `hydrated` exists. `completed` is `false` for the first
    // frames of every launch, so without this the tour flashes on every cold
    // start for someone who finished it months ago.
    expect(shouldShowTour({ completed: false, hydrated: false })).toBe(false)
  })

  it('is not shown once storage says it was completed', () => {
    expect(shouldShowTour({ completed: true, hydrated: true })).toBe(false)
  })

  it('is shown when storage has answered and it has not been seen', () => {
    expect(shouldShowTour({ completed: false, hydrated: true })).toBe(true)
  })

  it('stays hidden mid-launch even for someone who never completed it', () => {
    // Not knowing yet is not the same as not having seen it — the distinction
    // that would be invisible if this were `hydrated && !completed` inline.
    expect(shouldShowTour({ completed: false, hydrated: false })).toBe(false)
  })
})

describe('the overlay', () => {
  it('opens on the welcome step', async () => {
    await render(<OnboardingOverlay />)

    expect(screen.getByText('Welcome to MiO')).toBeTruthy()
  })

  it('walks forward through all five steps', async () => {
    await render(<OnboardingOverlay />)

    for (const title of [
      'Your library & player',
      // #502's step, between the library it is about and adding music.
      'Shortcuts worth knowing',
      'Add music your way',
      'Import & make it yours',
    ]) {
      await act(async () => {
        fireEvent.press(screen.getByText('Next'))
      })
      expect(screen.getByText(title)).toBeTruthy()
    }

    // The last step offers finishing rather than another Next.
    expect(screen.getByText('Get started')).toBeTruthy()
    expect(screen.queryByText('Next')).toBeNull()
  })

  it('walks back', async () => {
    await render(<OnboardingOverlay />)
    await act(async () => {
      fireEvent.press(screen.getByText('Next'))
    })

    await act(async () => {
      fireEvent.press(screen.getByText('Back'))
    })

    expect(screen.getByText('Welcome to MiO')).toBeTruthy()
  })

  it('offers no Back on the first step', async () => {
    await render(<OnboardingOverlay />)

    // Hidden rather than disabled: a disabled control on a phone is a target
    // that swallows a tap and says nothing.
    expect(screen.queryByText('Back')).toBeNull()
  })

  it('completes when skipped', async () => {
    await render(<OnboardingOverlay />)

    await act(async () => {
      fireEvent.press(screen.getByText('Skip'))
    })

    await waitFor(() => expect(useOnboarding.getState().completed).toBe(true))
  })

  it('completes on Get started', async () => {
    await render(<OnboardingOverlay />)
    for (let n = 0; n < STEPS_AFTER_FIRST; n++) {
      await act(async () => {
        fireEvent.press(screen.getByText('Next'))
      })
    }

    await act(async () => {
      fireEvent.press(screen.getByText('Get started'))
    })

    await waitFor(() => expect(useOnboarding.getState().completed).toBe(true))
  })

  it('renders its copy in Chinese too, from the shared catalogue', async () => {
    await i18n.changeLanguage('zh')

    await render(<OnboardingOverlay />)

    // The copy is shared with the web tour and already existed in both
    // languages — this is the assertion that mobile really is reading it.
    expect(screen.getByText('欢迎使用 MiO')).toBeTruthy()
  })
})

/**
 * The inline gesture hints (#502).
 *
 * after the device pass: *"some of the feature user might not know, like
 * swipe track right to add to user queue."* The tour gained a step, but a tour
 * is seen once and forgotten — the hint that sits where the gesture lives is
 * the half that teaches.
 */
describe('when a gesture hint is shown', () => {
  const armed = { completed: true, hydrated: true, dismissedHints: {} }

  it('is not shown before storage has answered', () => {
    // Same reasoning as the tour, and sharper: a hint that flashes onto the
    // library for two frames draws the eye to something already gone.
    expect(shouldShowHint({ ...armed, hydrated: false }, 'swipeToQueue')).toBe(false)
  })

  it('does not compete with the tour', () => {
    // The tour is a Modal and covers this, so overlapping could only teach a
    // gesture the user cannot reach.
    expect(shouldShowHint({ ...armed, completed: false }, 'swipeToQueue')).toBe(false)
  })

  it('is shown once the tour is done and the gesture is unlearned', () => {
    expect(shouldShowHint(armed, 'swipeToQueue')).toBe(true)
  })

  it('is not shown once dismissed', () => {
    expect(
      shouldShowHint({ ...armed, dismissedHints: { swipeToQueue: true } }, 'swipeToQueue'),
    ).toBe(false)
  })

  it('tracks each hint separately', () => {
    // One store field for two gestures, so this is the assertion that learning
    // one does not silently retire the other.
    const state = { ...armed, dismissedHints: { swipeToQueue: true } } as const
    expect(shouldShowHint(state, 'swipeToQueue')).toBe(false)
    expect(shouldShowHint(state, 'swipeToRemove')).toBe(true)
  })
})

describe('dismissing a hint', () => {
  it('survives a relaunch', async () => {
    await act(async () => {
      useOnboarding.getState().dismissHint('swipeToQueue')
    })

    const stored = JSON.parse((await AsyncStorage.getItem('mio-onboarding')) ?? '{}')
    // The whole point of the hint is that it appears once. Left out of
    // `partialize` it would come back on every cold start.
    expect(stored.state.dismissedHints).toEqual({ swipeToQueue: true })
  })

  it('is idempotent, because the gesture fires every time and not only the first', async () => {
    await act(async () => {
      useOnboarding.getState().dismissHint('swipeToRemove')
    })
    const first = useOnboarding.getState().dismissedHints

    await act(async () => {
      useOnboarding.getState().dismissHint('swipeToRemove')
    })

    // Same object, so a second swipe does not re-render every subscriber.
    expect(useOnboarding.getState().dismissedHints).toBe(first)
  })

  it('is re-armed by replaying the tour', async () => {
    await act(async () => {
      useOnboarding.getState().dismissHint('swipeToQueue')
      useOnboarding.getState().complete()
    })

    await act(async () => {
      useOnboarding.getState().reset()
    })

    // "Show me the introduction again" plainly means all of it — replaying only
    // the half that does not teach would be the wrong reading.
    expect(useOnboarding.getState().dismissedHints).toEqual({})
  })
})

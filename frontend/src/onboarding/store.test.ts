import { beforeEach, describe, expect, it } from 'vitest'

import { useOnboardingStore } from './store'

beforeEach(() => {
  localStorage.clear()
  useOnboardingStore.setState({ completed: false })
})

describe('onboarding store', () => {
  it('starts uncompleted, completes, and resets', () => {
    expect(useOnboardingStore.getState().completed).toBe(false)

    useOnboardingStore.getState().complete()
    expect(useOnboardingStore.getState().completed).toBe(true)

    useOnboardingStore.getState().reset()
    expect(useOnboardingStore.getState().completed).toBe(false)
  })

  it('persists the completed flag to localStorage', () => {
    useOnboardingStore.getState().complete()

    expect(JSON.parse(localStorage.getItem('mio-onboarding') ?? '{}').state.completed).toBe(true)
  })
})

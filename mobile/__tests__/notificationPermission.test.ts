import { PermissionsAndroid, Platform } from 'react-native'

import { notificationPermission, requestNotificationPermission } from '../src/system/notifications'

/**
 * The permission that decides whether anything MiO posts is ever seen (#472).
 *
 * The bug this covers was not a wrong answer, it was **never asking the
 * question**: `POST_NOTIFICATIONS` sat at `granted=false` on a fresh install
 * while a correct media session, a live foreground service and a well-formed
 * notification all did their work and were discarded by the OS.
 *
 * `Platform.OS`/`Platform.Version` are written per test because the whole
 * behaviour turns on them, and jest's default platform is not my phone.
 */

/**
 * Assigned in `beforeEach`, never captured at module load: `jest.spyOn`
 * *replaces* the property, so a handle taken up here would point at the real
 * function the spy displaced and every `mockResolvedValue` would fail.
 */
let check: jest.SpyInstance
let request: jest.SpyInstance

function androidVersion(version: number): void {
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true })
  Object.defineProperty(Platform, 'Version', { value: version, configurable: true })
}

const original = { OS: Platform.OS, Version: Platform.Version }

beforeEach(() => {
  check = jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(false)
  request = jest.spyOn(PermissionsAndroid, 'request').mockResolvedValue('granted' as never)
  androidVersion(35)
})

afterEach(() => {
  jest.restoreAllMocks()
  Object.defineProperty(Platform, 'OS', { value: original.OS, configurable: true })
  Object.defineProperty(Platform, 'Version', { value: original.Version, configurable: true })
})

it('asks when the permission is missing, and reports what the user chose', async () => {
  check.mockResolvedValue(false)
  request.mockResolvedValue('granted')

  await expect(requestNotificationPermission()).resolves.toBe('granted')
  expect(request).toHaveBeenCalledWith('android.permission.POST_NOTIFICATIONS')
})

it('reports a refusal as denied rather than as an error', async () => {
  check.mockResolvedValue(false)
  request.mockResolvedValue('never_ask_again')

  await expect(requestNotificationPermission()).resolves.toBe('denied')
})

/**
 * The one that protects something unrecoverable.
 *
 * Android shows this dialog at most **twice** per install and then never again;
 * the only way back is the system settings screen. Asking when the permission is
 * already held spends one of those on a question that has an answer, so `check`
 * has to gate `request` rather than sit beside it.
 */
it('does not spend a dialog when the permission is already held', async () => {
  check.mockResolvedValue(true)

  await expect(requestNotificationPermission()).resolves.toBe('granted')
  expect(request).not.toHaveBeenCalled()
})

/**
 * Below Android 13 the permission does not exist, and asking for one the
 * platform does not know answers `denied` — which would put a phone whose
 * notifications work perfectly into the "turn them back on" branch in Settings.
 */
it('treats Android 12 as nothing to ask, not as a refusal', async () => {
  androidVersion(32)

  await expect(notificationPermission()).resolves.toBe('not_required')
  await expect(requestNotificationPermission()).resolves.toBe('not_required')
  expect(check).not.toHaveBeenCalled()
  expect(request).not.toHaveBeenCalled()
})

it('treats a non-Android platform as nothing to ask', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true })

  await expect(notificationPermission()).resolves.toBe('not_required')
  expect(check).not.toHaveBeenCalled()
})

/**
 * A throw is its own answer, and not `denied`.
 *
 * `docs/lessons.md`: a boolean cannot be diagnosed. "The user said no" and "we
 * could not ask" want different responses — the first earns the Settings row,
 * the second is a bug report — so folding them together would put a misleading
 * instruction in front of someone it cannot help.
 */
it('names a platform failure instead of calling it a refusal', async () => {
  check.mockRejectedValue(new Error('no native module'))

  await expect(notificationPermission()).resolves.toBe('unavailable')
  await expect(requestNotificationPermission()).resolves.toBe('unavailable')
  expect(request).not.toHaveBeenCalled()
})

it('names a failure of the request itself', async () => {
  check.mockResolvedValue(false)
  request.mockRejectedValue(new Error('activity is gone'))

  await expect(requestNotificationPermission()).resolves.toBe('unavailable')
})

it('reads the current state without asking anything', async () => {
  check.mockResolvedValue(true)

  await expect(notificationPermission()).resolves.toBe('granted')
  expect(request).not.toHaveBeenCalled()
})

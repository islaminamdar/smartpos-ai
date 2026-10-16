import { beforeEach, describe, it, expect, vi } from 'vitest'
const m = vi.hoisted(() => ({
  getPinRecoveryState: vi.fn(),
  startPinRecovery: vi.fn(),
  retryPinRecovery: vi.fn(),
}))
vi.mock('../../../apps/android-pos/node_modules/@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    isPluginAvailable: () => true,
  },
  registerPlugin: () => m,
}))
import {
  parseNativePinRecoveryState,
  getNativePinRecoveryState,
  startNativePinRecovery,
  retryNativePinRecovery,
} from '../../../apps/android-pos/src/native'
const id = '10000000-0000-4000-8000-000000000001'
const ready = {
  schemaVersion: 1,
  status: 'ready',
  requestId: null,
  canStart: true,
  canRetry: false,
  passwordRequired: true,
  reasonCode: null,
}
const pending = {
  ...ready,
  status: 'pending',
  requestId: id,
  canStart: false,
  canRetry: true,
  reasonCode: 'pin_recovery_pending',
}
const completed = {
  ...ready,
  status: 'completed',
  requestId: id,
  passwordRequired: false,
  reasonCode: 'pin_recovery_completed',
}
beforeEach(() => vi.resetAllMocks())
describe('native PIN recovery metadata boundary', () => {
  it('accepts native read-only, signed-out pending, approved and completed states', () => {
    for (const state of [
      ready,
      pending,
      { ...pending, passwordRequired: false },
      {
        ...pending,
        status: 'approved',
        passwordRequired: false,
        reasonCode: 'pin_recovery_approved',
      },
      completed,
      { ...pending, status: 'blocked', canRetry: false, reasonCode: 'pin_recovery_conflict' },
      {
        ...ready,
        status: 'not_available',
        canStart: false,
        passwordRequired: false,
        reasonCode: 'pin_not_provisioned',
      },
    ])
      expect(parseNativePinRecoveryState(state)).toEqual(state)
  })
  it.each([
    { ...ready, extra: 'secret' },
    { ...ready, requestId: id },
    { ...pending, requestId: null },
    { ...pending, canStart: true },
    { ...completed, canRetry: true },
    { ...pending, status: 'approved' },
    { ...ready, status: 'blocked' },
    { ...ready, status: 'unknown' },
    { ...ready, reasonCode: 'unknown' },
    { ...ready, schemaVersion: 2 },
    { ...pending, requestId: 'invalid' },
    { ...ready, passwordRequired: 1 },
  ])('rejects malformed or contradictory metadata', (v) =>
    expect(() => parseNativePinRecoveryState(v)).toThrow()
  )
  it('calls only exact secret-free native methods and rejects different-request retry result', async () => {
    m.getPinRecoveryState.mockResolvedValue(ready)
    m.startPinRecovery.mockResolvedValue(completed)
    m.retryPinRecovery.mockResolvedValue(completed)
    expect(await getNativePinRecoveryState()).toEqual(ready)
    expect(await startNativePinRecovery()).toEqual(completed)
    expect(await retryNativePinRecovery(id)).toEqual(completed)
    expect(m.startPinRecovery).toHaveBeenCalledExactlyOnceWith()
    expect(m.retryPinRecovery).toHaveBeenCalledExactlyOnceWith({ requestId: id })
    m.retryPinRecovery.mockResolvedValue({
      ...completed,
      requestId: '10000000-0000-4000-8000-000000000002',
    })
    await expect(retryNativePinRecovery(id)).rejects.toThrow()
  })
  it('rejects invalid retry identity without invoking native and does not accept missing start identity', async () => {
    await expect(retryNativePinRecovery('wrong')).rejects.toThrow()
    expect(m.retryPinRecovery).not.toHaveBeenCalled()
    m.startPinRecovery.mockResolvedValue(ready)
    await expect(startNativePinRecovery()).rejects.toThrow()
  })
})

import nativeOutput from './fixtures/native-pin-recovery-android-output.json'
it('parses actual Android ready, pending, approved and completed metadata without transformation', () => {
  for (const state of Object.values(nativeOutput.states))
    expect(parseNativePinRecoveryState(state)).toEqual(state)
  expect(nativeOutput.states.completed.requestId).toBe(nativeOutput.states.pending.requestId)
})

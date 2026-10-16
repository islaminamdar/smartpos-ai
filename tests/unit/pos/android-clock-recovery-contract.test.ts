import { beforeEach, describe, it, expect, vi } from 'vitest'
import actualClock from './fixtures/native-clock-recovery-android-output.json'
const m = vi.hoisted(() => ({
  getNativeClockRecoveryState: vi.fn(),
  startNativeClockRecovery: vi.fn(),
  retryNativeClockRecovery: vi.fn(),
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
  parseNativeClockRecoveryState,
  getNativeClockRecoveryState,
  startNativeClockRecovery,
  retryNativeClockRecovery,
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
  reasonCode: 'clock_recovery_pending',
}
const completed = {
  ...ready,
  status: 'completed',
  canStart: false,
  requestId: id,
  passwordRequired: false,
  reasonCode: 'clock_recovery_completed',
}
beforeEach(() => vi.resetAllMocks())
describe('native clock recovery metadata boundary', () => {
  it.each(Object.entries(actualClock.states))(
    'accepts the actual Android %s metadata',
    (_name, state) => {
      expect(parseNativeClockRecoveryState(state)).toEqual(state)
      expect(Object.keys(state).sort()).toEqual([
        'canRetry',
        'canStart',
        'passwordRequired',
        'reasonCode',
        'requestId',
        'schemaVersion',
        'status',
      ])
    }
  )
  it('accepts native read-only, signed-out pending, approved and completed states', () => {
    for (const state of [
      ready,
      pending,
      { ...pending, passwordRequired: false },
      {
        ...pending,
        status: 'approved',
        passwordRequired: false,
        reasonCode: 'clock_recovery_approved',
      },
      completed,
      {
        ...pending,
        status: 'blocked',
        canRetry: false,
        passwordRequired: false,
        reasonCode: 'clock_recovery_conflict',
      },
      {
        ...ready,
        status: 'not_available',
        canStart: false,
        passwordRequired: false,
        reasonCode: 'clock_healthy',
      },
    ])
      expect(parseNativeClockRecoveryState(state)).toEqual(state)
  })
  it.each([
    { ...ready, extra: 'secret' },
    { ...ready, reasonCode: 'clock_healthy' },
    { ...pending, reasonCode: 'clock_recovery_completed' },
    { ...completed, reasonCode: 'clock_recovery_pending' },
    {
      ...ready,
      status: 'not_available',
      canStart: false,
      passwordRequired: false,
      reasonCode: 'native_storage_unavailable',
    },
    { ...ready, password: 'should-never-cross' },
    { ...ready, pin: '123456' },
    { ...ready, unixTime: 123 },
    { ...ready, status: { toString: () => 'ready' } },
    { ...ready, canRetry: true },
    { ...ready, passwordRequired: false },
    { ...completed, canStart: true },
    { ...completed, passwordRequired: true },
    { ...pending, status: 'blocked', canRetry: false, passwordRequired: false, reasonCode: null },
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
    expect(() => parseNativeClockRecoveryState(v)).toThrow()
  )
  it('calls only exact secret-free native methods and rejects different-request retry result', async () => {
    m.getNativeClockRecoveryState.mockResolvedValue(ready)
    m.startNativeClockRecovery.mockResolvedValue(completed)
    m.retryNativeClockRecovery.mockResolvedValue(completed)
    expect(await getNativeClockRecoveryState()).toEqual(ready)
    expect(await startNativeClockRecovery()).toEqual(completed)
    expect(await retryNativeClockRecovery({ requestId: id })).toEqual(completed)
    expect(m.startNativeClockRecovery).toHaveBeenCalledExactlyOnceWith()
    expect(m.retryNativeClockRecovery).toHaveBeenCalledExactlyOnceWith({ requestId: id })
    m.retryNativeClockRecovery.mockResolvedValue({
      ...completed,
      requestId: '10000000-0000-4000-8000-000000000002',
    })
    await expect(retryNativeClockRecovery({ requestId: id })).rejects.toThrow()
  })
  it('rejects invalid retry identity without invoking native and does not accept missing start identity', async () => {
    await expect(retryNativeClockRecovery({ requestId: 'wrong' })).rejects.toThrow()
    expect(m.retryNativeClockRecovery).not.toHaveBeenCalled()
    m.startNativeClockRecovery.mockResolvedValue(ready)
    await expect(startNativeClockRecovery()).rejects.toThrow()
  })
})

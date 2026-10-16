import { beforeEach, describe, expect, it, vi } from 'vitest'
const native = vi.hoisted(() => ({
  getNativeClockBootstrapState: vi.fn(),
  verifyNativeClockBootstrap: vi.fn(),
}))
vi.mock('../../../apps/android-pos/node_modules/@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    isPluginAvailable: () => true,
  },
  registerPlugin: () => native,
}))
import {
  parseNativeClockBootstrapState,
  parseNativeClockRecoveryState,
  getNativeClockBootstrapState,
  verifyNativeClockBootstrap,
} from '../../../apps/android-pos/src/native'
import actualBootstrap from './fixtures/native-clock-bootstrap-android-output.json'
const ready = actualBootstrap.states.ready
const completed = actualBootstrap.states.completed
beforeEach(() => vi.resetAllMocks())
describe('native pristine clock capability boundary', () => {
  it.each(Object.entries(actualBootstrap.states))(
    'accepts actual Android exported %s metadata',
    (_name, state) => {
      expect(parseNativeClockBootstrapState(state)).toEqual(state)
    }
  )
  it.each(Object.entries(actualBootstrap.ordinaryStates))(
    'accepts actual Android ordinary-clock %s metadata',
    (_name, state) => expect(parseNativeClockRecoveryState(state)).toEqual(state)
  )
  it.each([
    ready,
    completed,
    ...['clock_healthy', 'clock_bootstrap_not_eligible'].map((reasonCode) => ({
      schemaVersion: 1,
      status: 'not_available',
      canVerify: false,
      reasonCode,
    })),
    ...['native_storage_unavailable', 'offline_not_configured', 'clock_signal_unavailable'].map(
      (reasonCode) => ({ schemaVersion: 1, status: 'blocked', canVerify: false, reasonCode })
    ),
  ])('accepts only the finite status/capability/reason matrix %#', (state) =>
    expect(parseNativeClockBootstrapState(state)).toEqual(state)
  )
  it.each([
    null,
    [],
    {},
    { ...ready, schemaVersion: 2 },
    { ...ready, status: 'unknown' },
    { ...ready, canVerify: false },
    { ...ready, canVerify: 1 },
    { ...ready, reasonCode: 'clock_healthy' },
    { ...completed, canVerify: true },
    { ...completed, reasonCode: null },
    { ...ready, status: 'not_available' },
    { ...ready, status: 'blocked' },
    { ...completed, status: 'not_available' },
    { ...completed, status: 'blocked' },
    { ...ready, challenge: 'a'.repeat(64) },
    { ...ready, serverTimeMs: 123 },
    { ...ready, installationId: 'id' },
    { ...ready, password: 'forbidden' },
    { ...ready, pin: '123456' },
    { ...ready, status: { toString: () => 'ready' } },
  ])('rejects hostile, extra or contradictory metadata %#', (state) =>
    expect(() => parseNativeClockBootstrapState(state)).toThrow()
  )
  it('invokes native methods with zero arguments and validates the response', async () => {
    native.getNativeClockBootstrapState.mockResolvedValue(ready)
    native.verifyNativeClockBootstrap.mockResolvedValue(completed)
    expect(await getNativeClockBootstrapState()).toEqual(ready)
    expect(await verifyNativeClockBootstrap()).toEqual(completed)
    expect(native.getNativeClockBootstrapState).toHaveBeenCalledExactlyOnceWith()
    expect(native.verifyNativeClockBootstrap).toHaveBeenCalledExactlyOnceWith()
    native.verifyNativeClockBootstrap.mockResolvedValue({ ...completed, time: 1 })
    await expect(verifyNativeClockBootstrap()).rejects.toThrow()
    native.verifyNativeClockBootstrap.mockResolvedValue(ready)
    await expect(verifyNativeClockBootstrap()).rejects.toThrow()
  })
})

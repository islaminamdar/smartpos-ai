import { beforeEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ getNextAllocationState: vi.fn(), continueAfterAllocation: vi.fn(), unlockHistoricalPayment: vi.fn() }))
vi.mock('../../../apps/android-pos/node_modules/@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', isPluginAvailable: () => true }, registerPlugin: () => m }))
import { parseNativeNextAllocationState, getNativeNextAllocationState, continueNativeAfterAllocation, unlockNativeHistoricalPayment } from '../../../apps/android-pos/src/native'
import { id, intent } from './fixtures/native-checkout'
const ready = { schemaVersion: 1, status: 'ready', previousAuthorityId: id(1), shiftId: id(2), nextShiftId: null, reasonCode: null, canContinue: true }
const completed = { ...ready, status: 'completed', nextShiftId: id(2), canContinue: false }
beforeEach(() => vi.resetAllMocks())
it('accepts explicit ready and completed original-scope states without inventing a new allocation', () => {
  expect(parseNativeNextAllocationState(ready)).toEqual(ready)
  expect(parseNativeNextAllocationState(completed)).toEqual(completed)
  expect(parseNativeNextAllocationState({ ...completed, nextShiftId: null }).nextShiftId).toBeNull()
  expect(parseNativeNextAllocationState({ ...ready, status: 'pending', reasonCode: 'offline_continuation_uncertain' }).canContinue).toBe(true)
})
it.each([
  { ...ready, extra: 'unknown' }, { ...ready, previousAuthorityId: null }, { ...ready, canContinue: false },
  { ...completed, canContinue: true }, { ...completed, nextShiftId: id(3) },
  { ...completed, previousAuthorityId: null, shiftId: null },
  { ...ready, status: 'blocked' }, { ...ready, status: 'blocked', reasonCode: 'new_unknown' },
  { ...ready, nextShiftId: id(2) }, { ...ready, status: 'not_available' },
])('rejects inconsistent transition permissions and identities', value => expect(() => parseNativeNextAllocationState(value)).toThrow())
it('validates native reads and only sends the exact original allocation ID', async () => {
  m.getNextAllocationState.mockResolvedValue(ready)
  expect(await getNativeNextAllocationState()).toEqual(ready)
  m.continueAfterAllocation.mockResolvedValue(completed)
  expect(await continueNativeAfterAllocation(id(1))).toEqual(completed)
  expect(m.continueAfterAllocation).toHaveBeenCalledExactlyOnceWith({ previousAuthorityId: id(1) })
  for (const value of [ready, { ...completed, previousAuthorityId: id(4) }]) {
    m.continueAfterAllocation.mockResolvedValue(value)
    await expect(continueNativeAfterAllocation(id(1))).rejects.toThrow()
  }
})
it('validates historical PIN readback and rejects an intent from a different payment', async () => {
  m.unlockHistoricalPayment.mockResolvedValue(intent)
  expect(await unlockNativeHistoricalPayment(intent.intentId)).toEqual(intent)
  expect(m.unlockHistoricalPayment).toHaveBeenCalledExactlyOnceWith({ intentId: intent.intentId })
  m.unlockHistoricalPayment.mockResolvedValue({ ...intent, intentId: id(44) })
  await expect(unlockNativeHistoricalPayment(intent.intentId)).rejects.toThrow()
})

it('recognizes a pending native drawer close without permitting continuation',()=>{
 const blocked={...ready,status:'blocked',canContinue:false,reasonCode:'native_shift_close_pending'}
 expect(parseNativeNextAllocationState(blocked)).toEqual(blocked)
})

import { describe, expect, it } from 'vitest'
import fixture from './fixtures/native-next-allocation-android-output.json'
import { parseNativeNextAllocationState, parseOfflineState } from '../../../apps/android-pos/src/native'

// Actual API35 NativeNextAllocationTest output, using isolated synthetic records.
// Production issuance remained disabled; no real account, shift or bill was changed.
describe('actual Android next allocation output', () => {
  it('accepts all native custody states without adding permission', () => {
    expect(Object.keys(fixture.nextAllocationStates)).toEqual([
      'unprepared', 'active', 'uploadPending', 'ready', 'completed', 'archivePending', 'closedCompleted', 'signedOut',
    ])
    for (const value of Object.values(fixture.nextAllocationStates)) {
      expect(parseNativeNextAllocationState(value)).toEqual(value)
    }
    expect(fixture.nextAllocationStates.uploadPending.canContinue).toBe(false)
    expect(fixture.nextAllocationStates.archivePending.canContinue).toBe(true)
    expect(fixture.nextAllocationStates.signedOut.previousAuthorityId).toBeNull()
  })
  it('preserves original allocation identity through archive retry and later shift closure', () => {
    const { ready, completed, archivePending, closedCompleted } = fixture.nextAllocationStates
    for (const state of [completed, archivePending, closedCompleted]) {
      expect(state.previousAuthorityId).toBe(ready.previousAuthorityId)
      expect(state.shiftId).toBe(ready.shiftId)
    }
    expect(completed.nextShiftId).toBe(ready.shiftId)
    expect(closedCompleted.nextShiftId).toBeNull()
    expect(parseOfflineState(fixture.closedPreparation)).toEqual(fixture.closedPreparation)
    expect(fixture.closedPreparation.canIssue).toBe(false)
    expect(fixture.closedPreparation.authority).toBeNull()
    expect(fixture.closedPreparation.shiftId).toBeNull()
  })
})

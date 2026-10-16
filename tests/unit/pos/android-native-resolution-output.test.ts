import { describe, expect, it } from 'vitest'
import fixture from './fixtures/native-payment-resolution-android-output.json'
import { parseNativeCheckoutState, parseNativeIntent } from '../../../apps/android-pos/src/native'

// Actual API35 NativePaymentResolutionTest output. Synthetic merchant and keys;
// the production issuance gate remained disabled throughout this export.
describe('actual Android signed manager outcome bridge', () => {
  it('accepts frozen, pending, accepted, locked and signed-out native states', () => {
    expect(fixture.synthetic).toBe(true)
    expect(fixture.states.map(s => s.name)).toEqual(['frozen', 'pending', 'accepted', 'locked', 'signed_out'])
    for (const { value } of fixture.states) {
      expect(parseNativeCheckoutState(value)).toEqual(value)
      expect(value.canIssue).toBe(false)
      expect(value.lastReceipt).toBeNull()
    }
    const accepted = fixture.states.find(s => s.name === 'accepted')!.value
    expect(accepted.pendingIntentId).toBeNull()
    expect(accepted.lastResolvedIntentId).toBe(accepted.lastResolvedIntent?.intentId)
    for (const name of ['locked', 'signed_out']) {
      const value = fixture.states.find(s => s.name === name)!.value
      expect(value.lastResolvedIntent).toBeNull()
      expect(value.unresolvedIntent).toBeNull()
      if (name === 'signed_out') expect(value.context).toBeNull()
    }
  })
  it('accepts the original payment through native outcome acceptance without an invoice', () => {
    for (const { value } of fixture.intents) {
      expect(parseNativeIntent(value)).toEqual(value)
      expect(value.canConfirm).toBe(false)
      expect(value.canCancel).toBe(false)
      expect(value.receipt).toBeNull()
    }
    const original = fixture.intents[0].value
    const accepted = fixture.intents.find(s => s.name === 'accepted')!.value
    expect(accepted.request).toEqual(original.request)
    expect(accepted.intentId).toBe(original.intentId)
    expect(accepted.state).toBe('manager_resolved')
    expect(accepted.managerReview.status).toBe('accepted_on_device')
  })
})

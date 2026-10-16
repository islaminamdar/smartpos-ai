import { describe, expect, it } from 'vitest'
import fixture from './fixtures/native-payment-freeze-android-output.json'
import {
  parseNativeCheckoutState,
  parseNativeIntent,
} from '../../../apps/android-pos/src/native'

// Synthetic records exported by NativePaymentFreezeTest on Android. These
// exercise the actual Java-to-TypeScript boundary, not live merchant data.
describe('actual Android permanent payment freeze output', () => {
  it('accepts the original frozen intent and its locally saved proof', () => {
    const intent = parseNativeIntent(fixture.intentDisplay)
    expect(intent).toEqual(fixture.intentDisplay)
    expect(intent.state).toBe('frozen_for_manager')
    expect(intent.canConfirm).toBe(false)
    expect(intent.canCancel).toBe(false)
    expect(intent.receipt).toBeNull()
    expect(intent.reasonCode).toBe('payment_frozen')
    expect(intent.managerReview?.status).toBe('saved_locally')
  })

  it('keeps the native frozen payment unresolved without authorizing new sales', () => {
    const state = parseNativeCheckoutState(fixture.counterState)
    expect(state).toEqual(fixture.counterState)
    expect(state.canIssue).toBe(false)
    expect(state.reasonCode).toBe('payment_frozen')
    expect(state.pendingIntentId).toBe(fixture.intentDisplay.intentId)
    expect(state.unresolvedIntent).toEqual(fixture.intentDisplay)
    expect(state.lastReceiptId).toBeNull()
    expect(state.lastReceipt).toBeNull()
  })
})

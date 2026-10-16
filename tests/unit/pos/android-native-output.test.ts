import { describe, expect, it } from 'vitest'
import fixture from './fixtures/native-counter-android-output.json'
import {
  parseNativeCheckoutState,
  parseNativeIntent,
  parseNativeQuote,
  parseNativeReceipt,
} from '../../../apps/android-pos/src/native'

// Exported by NativeCheckoutCoordinatorTest on an actual Android API 35 emulator.
// Synthetic data; native production issuance remains disabled. This checks the
// cross-language serialization boundary, not mock-only agreement between TS fixtures.
describe('actual Android counter bridge output', () => {
  const samples = fixture.samples
  it('accepts all native state transitions including locked and signed out', () => {
    for (const state of [
      samples.initialState,
      samples.pendingState,
      samples.committedState,
      samples.lockedState,
      samples.signedOutState,
    ]) {
      expect(parseNativeCheckoutState(state)).toEqual(state)
    }
    expect(samples.lockedState.lastReceipt).toBeNull()
    expect(samples.signedOutState.context).toBeNull()
  })
  it('accepts native quotes, saved intents and the original immutable receipt', () => {
    expect(parseNativeQuote(samples.quote)).toEqual(samples.quote)
    expect(parseNativeIntent(samples.pendingIntent)).toEqual(samples.pendingIntent)
    expect(parseNativeIntent(samples.committedIntent)).toEqual(samples.committedIntent)
    expect(parseNativeReceipt(samples.receipt)).toEqual(samples.receipt)
    expect(samples.committedIntent.receipt).toEqual(samples.receipt)
    expect(samples.pendingIntent.request).toEqual(samples.committedIntent.request)
  })
})

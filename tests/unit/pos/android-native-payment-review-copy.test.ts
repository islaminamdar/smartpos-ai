import { describe, expect, it } from 'vitest'
import { nativeCheckoutError } from '../../../apps/android-pos/src/native'

describe('native payment-review recovery guidance', () => {
  it('keeps the frozen-payment error accurate for local, pending and conflict reviews', () => {
    const message = nativeCheckoutError(new Error('payment_frozen'))
    expect(message).toContain('Check its saved review status')
    expect(message).toContain('Do not collect again')
    expect(message).not.toContain('has not been sent')
  })

  it('requires checking the original payment after uncertain recovery without repeating funds actions', () => {
    const message = nativeCheckoutError(new Error('offline_payment_recovery_uncertain'))
    expect(message).toContain('Check this same saved payment before retrying')
    expect(message).toContain('Do not collect again or repeat a return or card void')
  })
})

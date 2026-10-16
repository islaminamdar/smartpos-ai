import { describe, it, expect } from 'vitest'
import {
  parseNativeCheckoutState,
  parseNativeQuote,
  parseNativeIntent,
  parseNativeReceipt,
  quantityToMilli,
  knownCheckoutReason,
} from '../../../apps/android-pos/src/native'
import { state, quote, intent, receipt, id } from './fixtures/native-checkout'
describe('native authoritative checkout boundary', () => {
  it('accepts the complete native contract and exact receipt', () => {
    expect(parseNativeCheckoutState(state)).toEqual(state)
    expect(parseNativeQuote(quote)).toEqual(quote)
    expect(parseNativeIntent(intent)).toEqual(intent)
    expect(parseNativeReceipt(receipt)).toEqual(receipt)
  })
  it('accepts retained reference-only state without leaking financial details', () => {
    expect(
      parseNativeCheckoutState({
        ...state,
        canIssue: false,
        context: null,
        pendingIntentId: id(8),
        lastReceiptId: id(9),
        reasonCode: 'native_session_expired',
      }).unresolvedIntent
    ).toBeNull()
  })
  it.each([
    { ...state, pendingIntentId: 'bad' },
    { ...state, unresolvedIntent: intent },
    { ...state, lastReceipt: receipt },
    { ...state, pendingIntentId: id(8) },
    { ...state, reasonCode: 'new_unknown_code' },
    { ...state, extra: 'unexpected' },
  ])('rejects inconsistent issuance or record references', (value) =>
    expect(() => parseNativeCheckoutState(value)).toThrow()
  )
  it.each([
    { ...quote, totals: { ...quote.totals, taxFils: 24 } },
    { ...quote, request: { ...quote.request, presentedTotalFils: 526 } },
    { ...quote, lines: [{ ...quote.lines[0], quantityMilli: 500 }] },
    { ...quote, payments: [{ method: 'card', amountFils: 1 }] },
  ])('rejects mismatched native quote', (value) => expect(() => parseNativeQuote(value)).toThrow())
  it('rejects a committed receipt for a different item or buyer', () => {
    const committed = {
      ...intent,
      state: 'committed',
      canConfirm: false,
      canCancel: false,
      receipt,
    }
    expect(parseNativeIntent(committed).state).toBe('committed')
    expect(() =>
      parseNativeIntent({
        ...committed,
        receipt: { ...receipt, lines: [{ ...receipt.lines[0], name: 'Different item' }] },
      })
    ).toThrow()
    expect(() =>
      parseNativeIntent({
        ...committed,
        receipt: { ...receipt, customer: { name: 'Different', address: 'Address', trn: null } },
      })
    ).toThrow()
  })
  it.each([
    ['0.125', 'kg', 125],
    ['1.234', 'kg', 1234],
    ['2', 'piece', 2000],
    ['2.000', 'pack', 2000],
    ['0.5', 'piece', null],
    ['1.1234', 'kg', null],
    ['0', 'kg', null],
    ['1001', 'kg', null],
  ])('converts exact quantity %s/%s without floating rounding', (value, unit, expected) =>
    expect(quantityToMilli(value as string, unit as 'kg')).toBe(expected)
  )
  it('unknown native reason never grants UI action permission', () => {
    expect(knownCheckoutReason('unknown_new_reason')).toBe(false)
    expect(knownCheckoutReason('pin_unlock_required')).toBe(true)
  })
})

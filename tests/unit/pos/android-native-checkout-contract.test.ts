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

describe('permanent native payment freeze boundary', () => {
  const frozen = {
    ...intent,
    state: 'frozen_for_manager',
    canConfirm: false,
    canCancel: false,
    reasonCode: 'payment_frozen',
    managerReview: { freezeId: id(12), proofSha256: 'a'.repeat(64), status: 'saved_locally' },
  }
  it('accepts only locally saved frozen proof while keeping the intent unresolved', () => {
    expect(parseNativeIntent(frozen)).toEqual(frozen)
    expect(
      parseNativeCheckoutState({
        ...state,
        canIssue: false,
        pendingIntentId: intent.intentId,
        unresolvedIntent: frozen,
        reasonCode: 'payment_frozen',
      }).pendingIntentId
    ).toBe(intent.intentId)
  })
  it.each([
    { ...frozen, canConfirm: true },
    { ...frozen, canCancel: true },
    { ...frozen, reasonCode: null },
    { ...frozen, receipt },
    { ...frozen, managerReview: undefined },
    { ...frozen, managerReview: { ...frozen.managerReview, freezeId: 'bad' } },
    { ...frozen, managerReview: { ...frozen.managerReview, proofSha256: 'A'.repeat(64) } },
    { ...frozen, managerReview: { ...frozen.managerReview, status: 'submitted' } },
    { ...intent, managerReview: frozen.managerReview },
  ])('rejects mutable, claimed submitted or malformed freeze state', (value) =>
    expect(() => parseNativeIntent(value)).toThrow()
  )
})

describe('accepted native manager outcome boundary', () => {
  const accepted = {
    ...intent, state: 'manager_resolved', canConfirm: false, canCancel: false,
    reasonCode: null, receipt: null,
    managerReview: { freezeId: id(12), proofSha256: 'a'.repeat(64),
      status: 'accepted_on_device', resolutionId: id(13), decision: 'funds_returned',
      resolvedAt: '2026-10-16T12:00:00.000Z' },
  }
  it('retains an accepted outcome separately from an invoice or new permission', () => {
    expect(parseNativeIntent(accepted)).toEqual(accepted)
    const result = parseNativeCheckoutState({ ...state, canIssue: false,
      reasonCode: 'native_checkout_unavailable', lastResolvedIntentId: intent.intentId,
      lastResolvedIntent: accepted })
    expect(result.lastReceipt).toBeNull()
    expect(result.canIssue).toBe(false)
  })
  it.each([
    { ...accepted, receipt }, { ...accepted, canConfirm: true },
    { ...accepted, canCancel: true }, { ...accepted, reasonCode: 'payment_frozen' },
    ...['pending', 'saved_locally', 'conflict'].map(status => ({ ...accepted,
      managerReview: { ...accepted.managerReview, status } })),
    { ...accepted, managerReview: { ...accepted.managerReview, decision: 'replacement_invoice' } },
    { ...accepted, managerReview: { ...accepted.managerReview, resolutionId: 'bad' } },
    { ...accepted, managerReview: { ...accepted.managerReview, resolvedAt: null } },
  ])('rejects impossible or unknown terminal permission and evidence', value => {
    expect(() => parseNativeIntent(value)).toThrow()
  })
  it('rejects another allocation, conflicting references and unlocked details without a context', () => {
    const result = { ...state, canIssue: false, reasonCode: 'native_checkout_unavailable',
      lastResolvedIntentId: intent.intentId, lastResolvedIntent: accepted }
    for (const value of [
      { ...result, context: null },
      { ...result, pendingIntentId: intent.intentId },
      { ...result, lastResolvedIntentId: id(15) },
      { ...result, context: { ...state.context!, authorityId: id(16) } },
      { ...result, lastResolvedIntent: intent },
    ]) expect(() => parseNativeCheckoutState(value)).toThrow()
  })
})

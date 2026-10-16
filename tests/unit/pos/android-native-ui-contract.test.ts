import { describe, expect, it } from 'vitest'
import { parseIdentity, parseReceipts, parseStatus } from '../../../apps/android-pos/src/native'

const status = {
  schemaVersion: 1,
  receiptCount: 2,
  pendingCount: 1,
  lastAcknowledgedAt: null,
  canIssue: false,
  reason: 'authority_not_configured',
}
const receipt = {
  id: 'receipt-1',
  documentNumber: 'BD-0001',
  issuedAt: '2026-10-16T09:00:00.000Z',
  totalFils: 525,
  syncState: 'pending',
}

describe('Android foundation UI contract', () => {
  it('accepts verified paused status and preserves missing acknowledgement', () => {
    expect(parseStatus(status)).toEqual(status)
    expect(parseStatus({ ...status, receiptCount: 0, pendingCount: 0 }).receiptCount).toBe(0)
  })
  it.each([
    { ...status, canIssue: true },
    { ...status, reason: 'ready' },
    { ...status, pendingCount: 3 },
    { ...status, receiptCount: -1 },
    { ...status, receiptCount: 1.2 },
    { ...status, lastAcknowledgedAt: 'not-a-date' },
    { ...status, unknown: true },
  ])('rejects unknown or inconsistent readiness without claiming permission', (value) => {
    expect(() => parseStatus(value)).toThrow()
  })
  it('accepts native identity without exposing a private key', () => {
    const value = {
      installationId: 'install-1',
      publicKeySpkiBase64Url: 'a'.repeat(100),
      deviceKeySha256: 'b'.repeat(64),
    }
    expect(parseIdentity(value)).toEqual(value)
    expect(() => parseIdentity({ ...value, privateKey: 'unexpected' })).toThrow()
    expect(() => parseIdentity({ ...value, deviceKeySha256: 'invalid' })).toThrow()
  })
  it('preserves real receipt amounts, pending state and history truncation', () => {
    expect(parseReceipts({ receipts: [receipt], hasMore: true })).toEqual({
      receipts: [receipt],
      hasMore: true,
    })
    expect(parseReceipts({ receipts: [], hasMore: false })).toEqual({
      receipts: [],
      hasMore: false,
    })
  })
  it.each([
    { receipts: [receipt, receipt], hasMore: false },
    { receipts: [{ ...receipt, totalFils: -5 }], hasMore: false },
    { receipts: [{ ...receipt, totalFils: 1.5 }], hasMore: false },
    { receipts: [{ ...receipt, syncState: 'paid' }], hasMore: false },
    { receipts: [{ ...receipt, issuedAt: 'invalid' }], hasMore: false },
    { receipts: [receipt] },
  ])('fails closed on malformed receipt summaries', (value) => {
    expect(() => parseReceipts(value)).toThrow()
  })
})

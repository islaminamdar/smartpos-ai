import { describe, expect, it } from 'vitest'
import {
  parseIdentity,
  parseReceipts,
  parseStatus,
  parseAccessState,
  nativeAccessError,
} from '../../../apps/android-pos/src/native'

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

describe('Native access response boundary', () => {
  const branch = {
    id: '10000000-0000-4000-8000-000000000001',
    organizationId: '10000000-0000-4000-8000-000000000002',
    name: 'Synthetic branch',
    role: 'manager',
  }
  const access = {
    schemaVersion: 1,
    status: 'signed_in',
    actorId: '10000000-0000-4000-8000-000000000003',
    branches: [branch],
    device: null,
    canPrepareOffline: false,
  }
  it('accepts signed-in scope without implying offline preparation', () => {
    expect(parseAccessState(access).canPrepareOffline).toBe(false)
    expect(
      parseAccessState({ ...access, status: 'signed_out', actorId: null, branches: [] }).status
    ).toBe('signed_out')
  })
  it.each([
    { ...access, status: 'signed_out' },
    { ...access, actorId: null },
    { ...access, branches: [branch, branch] },
    { ...access, branches: [{ ...branch, role: 'admin' }] },
    { ...access, canPrepareOffline: true },
    { ...access, accessToken: 'must-never-cross-bridge' },
    {
      ...access,
      device: { id: branch.id, branchId: access.actorId, name: 'Foreign branch device' },
    },
  ])('rejects inconsistent scope or secret-bearing responses', (value) => {
    expect(() => parseAccessState(value)).toThrow()
  })
  it('shows safe recovery directions for uncertain enrollment and generic failures', () => {
    expect(nativeAccessError({ code: 'native_enrollment_uncertain' })).toMatch(/Check access/)
    expect(nativeAccessError(new Error('sensitive unexpected payload'))).not.toContain('sensitive')
  })
})

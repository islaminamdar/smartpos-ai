import { Capacitor, registerPlugin } from '@capacitor/core'

export type NativeIdentity = {
  installationId: string
  publicKeySpkiBase64Url: string
  deviceKeySha256: string
}
export type NativeStatus = {
  schemaVersion: 1
  receiptCount: number
  pendingCount: number
  lastAcknowledgedAt: string | null
  canIssue: false
  reason: 'authority_not_configured'
}
export type NativeReceiptSummary = {
  id: string
  documentNumber: string
  issuedAt: string
  totalFils: number
  syncState: 'pending' | 'acknowledged'
}
export type NativeReceiptList = { receipts: NativeReceiptSummary[]; hasMore: boolean }
export type DeviceSnapshot = {
  identity: NativeIdentity
  status: NativeStatus
  history: NativeReceiptList
  checkedAt: string
}
interface NativeLedgerPlugin {
  getIdentity(): Promise<unknown>
  getStatus(): Promise<unknown>
  listReceipts(): Promise<unknown>
}
const ledger = registerPlugin<NativeLedgerPlugin>('NativeLedger')

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_native_response')
  const object = value as Record<string, unknown>
  if (
    Object.keys(object).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(object, key))
  ) {
    throw new Error('invalid_native_response')
  }
  return object
}
export function parseIdentity(value: unknown): NativeIdentity {
  const result = record(value, ['installationId', 'publicKeySpkiBase64Url', 'deviceKeySha256'])
  if (
    typeof result.installationId !== 'string' ||
    !/^[a-zA-Z0-9-]{1,128}$/.test(result.installationId) ||
    typeof result.publicKeySpkiBase64Url !== 'string' ||
    !/^[A-Za-z0-9_-]{32,2048}$/.test(result.publicKeySpkiBase64Url) ||
    typeof result.deviceKeySha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(result.deviceKeySha256)
  ) {
    throw new Error('invalid_native_response')
  }
  return result as NativeIdentity
}
export function parseStatus(value: unknown): NativeStatus {
  const result = record(value, [
    'schemaVersion',
    'receiptCount',
    'pendingCount',
    'lastAcknowledgedAt',
    'canIssue',
    'reason',
  ])
  if (
    result.schemaVersion !== 1 ||
    result.canIssue !== false ||
    result.reason !== 'authority_not_configured' ||
    !Number.isSafeInteger(result.receiptCount) ||
    Number(result.receiptCount) < 0 ||
    !Number.isSafeInteger(result.pendingCount) ||
    Number(result.pendingCount) < 0 ||
    Number(result.pendingCount) > Number(result.receiptCount) ||
    (result.lastAcknowledgedAt !== null &&
      (typeof result.lastAcknowledgedAt !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result.lastAcknowledgedAt) ||
        !Number.isFinite(Date.parse(result.lastAcknowledgedAt))))
  ) {
    throw new Error('invalid_native_response')
  }
  return result as NativeStatus
}
export function parseReceipts(value: unknown): NativeReceiptList {
  const result = record(value, ['receipts', 'hasMore'])
  if (!Array.isArray(result.receipts) || typeof result.hasMore !== 'boolean')
    throw new Error('invalid_native_response')
  const ids = new Set<string>()
  const receipts = result.receipts.map((value) => {
    const receipt = record(value, ['id', 'documentNumber', 'issuedAt', 'totalFils', 'syncState'])
    if (
      typeof receipt.id !== 'string' ||
      !/^[a-zA-Z0-9-]{1,128}$/.test(receipt.id) ||
      ids.has(receipt.id) ||
      typeof receipt.documentNumber !== 'string' ||
      !receipt.documentNumber.trim() ||
      receipt.documentNumber.length > 160 ||
      typeof receipt.issuedAt !== 'string' ||
      !Number.isFinite(Date.parse(receipt.issuedAt)) ||
      !Number.isSafeInteger(receipt.totalFils) ||
      Number(receipt.totalFils) < 0 ||
      !['pending', 'acknowledged'].includes(String(receipt.syncState))
    )
      throw new Error('invalid_native_response')
    ids.add(receipt.id)
    return receipt as NativeReceiptSummary
  })
  return { receipts, hasMore: result.hasMore }
}
export function hasNativeLedger(): boolean {
  return (
    Capacitor.isNativePlatform() &&
    Capacitor.getPlatform() === 'android' &&
    Capacitor.isPluginAvailable('NativeLedger')
  )
}
export async function readDeviceSnapshot(): Promise<DeviceSnapshot> {
  if (!hasNativeLedger()) throw new Error('native_unavailable')
  const [identity, status, receipts] = await Promise.all([
    ledger.getIdentity(),
    ledger.getStatus(),
    ledger.listReceipts(),
  ])
  return {
    identity: parseIdentity(identity),
    status: parseStatus(status),
    history: parseReceipts(receipts),
    checkedAt: new Date().toISOString(),
  }
}

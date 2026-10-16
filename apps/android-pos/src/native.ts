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
  getOfflineState(): Promise<unknown>
  openOfflineShift(input: { openingCashFils: number }): Promise<unknown>
  prepareOffline(): Promise<unknown>
  unlockOffline(): Promise<unknown>
  lockOffline(): Promise<unknown>
  getIdentity(): Promise<unknown>
  getStatus(): Promise<unknown>
  listReceipts(): Promise<unknown>
  getAccessState(): Promise<unknown>
  signIn(): Promise<unknown>
  signOut(): Promise<unknown>
  enrollCounter(input: { branchId: string; name: string }): Promise<unknown>
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

export type NativeAccessState = {
  schemaVersion: 1
  status: 'signed_out' | 'signed_in'
  actorId: string | null
  branches: {
    id: string
    organizationId: string
    name: string
    role: 'owner' | 'manager' | 'cashier'
  }[]
  device: { id: string; branchId: string; name: string } | null
  canPrepareOffline: boolean
}
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
export function parseAccessState(value: unknown): NativeAccessState {
  const result = record(value, [
    'schemaVersion',
    'status',
    'actorId',
    'branches',
    'device',
    'canPrepareOffline',
  ])
  if (
    result.schemaVersion !== 1 ||
    !['signed_out', 'signed_in'].includes(String(result.status)) ||
    typeof result.canPrepareOffline !== 'boolean' ||
    !Array.isArray(result.branches)
  )
    throw new Error('invalid_native_response')
  const ids = new Set<string>()
  const branches = result.branches.map((value) => {
    const branch = record(value, ['id', 'organizationId', 'name', 'role'])
    if (
      !uuid(branch.id) ||
      !uuid(branch.organizationId) ||
      ids.has(branch.id) ||
      typeof branch.name !== 'string' ||
      !branch.name.trim() ||
      branch.name.length > 200 ||
      !['owner', 'manager', 'cashier'].includes(String(branch.role))
    )
      throw new Error('invalid_native_response')
    ids.add(branch.id)
    return branch as NativeAccessState['branches'][number]
  })
  let device: NativeAccessState['device'] = null
  if (result.device !== null) {
    const raw = record(result.device, ['id', 'branchId', 'name'])
    if (
      !uuid(raw.id) ||
      !uuid(raw.branchId) ||
      !ids.has(raw.branchId) ||
      typeof raw.name !== 'string' ||
      !raw.name.trim() ||
      raw.name.length > 80
    )
      throw new Error('invalid_native_response')
    device = raw as NonNullable<NativeAccessState['device']>
  }
  if (result.status === 'signed_out') {
    if (result.actorId !== null || branches.length || device !== null || result.canPrepareOffline)
      throw new Error('invalid_native_response')
  } else if (!uuid(result.actorId)) throw new Error('invalid_native_response')
  if (result.canPrepareOffline && !device) throw new Error('invalid_native_response')
  return {
    schemaVersion: 1,
    status: result.status as NativeAccessState['status'],
    actorId: result.actorId as string | null,
    branches,
    device,
    canPrepareOffline: result.canPrepareOffline,
  }
}
export function nativeAccessErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const candidate = error as { code?: unknown; message?: unknown }
  return typeof candidate.code === 'string' && candidate.code.startsWith('native_')
    ? candidate.code
    : typeof candidate.message === 'string'
      ? candidate.message
      : ''
}
export function nativeAccessError(error: unknown): string {
  switch (nativeAccessErrorCode(error)) {
    case 'native_counter_account_required':
      return 'This counter is enrolled to another staff account. Sign in with that account or ask your manager for recovery. Keep this device identity and its saved records.'
    case 'native_sign_out_pending':
      return 'Signed out on this device. Connect to finish server sign-out.'
    case 'native_authentication_failed':
      return 'Sign-in could not be confirmed. Check your details in the Android sign-in dialog and try again.'
    case 'native_network_unavailable':
      return 'Connect to the internet, then check access again. Saved device records are kept.'
    case 'native_session_expired':
      return 'Your session has expired. Check access, then sign in again using the Android dialog.'
    case 'native_enrollment_uncertain':
      return 'Counter enrollment needs confirmation. Check access before trying again; do not register another counter to replace this attempt.'
    case 'native_storage_unavailable':
      return 'Device access could not be saved or read. Keep this app’s data and retry the check. Do not clear storage or reinstall.'
    case 'native_access_unavailable':
      return 'Restaurant access could not be confirmed. Check access again, or ask your branch owner for help.'
    default:
      return 'Access could not be confirmed. Check access again before making another change.'
  }
}
function requireNativeAccess() {
  if (!hasNativeLedger()) throw new Error('native_unavailable')
}
export async function readAccessState(): Promise<NativeAccessState> {
  requireNativeAccess()
  return parseAccessState(await ledger.getAccessState())
}
export async function signInNative(): Promise<NativeAccessState> {
  requireNativeAccess()
  const state = parseAccessState(await ledger.signIn())
  if (state.status !== 'signed_in') throw new Error('invalid_native_response')
  return state
}
export async function signOutNative(): Promise<NativeAccessState> {
  requireNativeAccess()
  const state = parseAccessState(await ledger.signOut())
  if (state.status !== 'signed_out') throw new Error('invalid_native_response')
  return state
}
export async function enrollNativeCounter(input: {
  branchId: string
  name: string
}): Promise<NativeAccessState> {
  requireNativeAccess()
  if (!uuid(input.branchId) || !input.name.trim() || input.name.trim().length > 80)
    throw new Error('invalid_native_input')
  const state = parseAccessState(
    await ledger.enrollCounter({ branchId: input.branchId, name: input.name.trim() })
  )
  if (state.status !== 'signed_in' || state.device?.branchId !== input.branchId)
    throw new Error('invalid_native_response')
  return state
}

export type NativeOfflineState = {
  schemaVersion: 1
  status: 'not_prepared' | 'locked' | 'prepared' | 'blocked'
  stage: 'sign_in' | 'enroll_counter' | 'open_shift' | 'prepare' | 'unlock' | 'prepared' | 'recover'
  canIssue: false
  shiftId: string | null
  authority: null | { id: string; expiresAt: string; firstInvoice: number; lastInvoice: number }
  pinProvisioned: boolean
  noticeCode: string | null
  pendingAction: 'open_shift' | 'prepare' | null
  pendingOpeningCashFils: number | null
}
export function parseOfflineState(value: unknown): NativeOfflineState {
  const result = record(value, [
    'schemaVersion',
    'status',
    'stage',
    'canIssue',
    'shiftId',
    'authority',
    'pinProvisioned',
    'noticeCode',
    'pendingAction',
    'pendingOpeningCashFils',
  ])
  if (
    result.schemaVersion !== 1 ||
    result.canIssue !== false ||
    !['not_prepared', 'locked', 'prepared', 'blocked'].includes(String(result.status)) ||
    ![
      'sign_in',
      'enroll_counter',
      'open_shift',
      'prepare',
      'unlock',
      'prepared',
      'recover',
    ].includes(String(result.stage)) ||
    (result.shiftId !== null && !uuid(result.shiftId)) ||
    typeof result.pinProvisioned !== 'boolean' ||
    (result.noticeCode !== null &&
      ![
        'offline_not_configured',
        'offline_permission_expired',
        'pin_confirmation_mismatch',
        'pin_kdf_unsupported',
        'offline_preparation_uncertain',
        'offline_shift_required',
        'offline_context_changed',
        'pin_unlock_required',
        'clock_source_blocked',
        'native_access_unavailable',
        'native_storage_unavailable',
      ].includes(String(result.noticeCode))) ||
    (result.pendingAction !== null &&
      result.pendingAction !== 'open_shift' &&
      result.pendingAction !== 'prepare') ||
    (result.pendingAction === 'open_shift'
      ? !Number.isSafeInteger(result.pendingOpeningCashFils) ||
        Number(result.pendingOpeningCashFils) < 0 ||
        Number(result.pendingOpeningCashFils) > 100000000
      : result.pendingOpeningCashFils !== null)
  )
    throw new Error('invalid_native_response')
  if (result.authority !== null) {
    const authority = record(result.authority, ['id', 'expiresAt', 'firstInvoice', 'lastInvoice'])
    if (
      !uuid(authority.id) ||
      typeof authority.expiresAt !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(authority.expiresAt) ||
      !Number.isFinite(Date.parse(authority.expiresAt)) ||
      !Number.isSafeInteger(authority.firstInvoice) ||
      Number(authority.firstInvoice) < 1 ||
      !Number.isSafeInteger(authority.lastInvoice) ||
      Number(authority.lastInvoice) < Number(authority.firstInvoice)
    )
      throw new Error('invalid_native_response')
  }
  if (
    result.status === 'prepared' &&
    (result.stage !== 'prepared' || !result.shiftId || !result.authority || !result.pinProvisioned)
  )
    throw new Error('invalid_native_response')
  return result as NativeOfflineState
}
export function nativeOfflineErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const value = error as { code?: unknown; message?: unknown }
  return typeof value.code === 'string'
    ? value.code
    : typeof value.message === 'string'
      ? value.message
      : ''
}
export function nativeOfflineError(error: unknown): string {
  switch (nativeOfflineErrorCode(error)) {
    case 'offline_not_configured':
      return 'Offline preparation is not configured in this app build. Ask your manager for the approved app update. Saved records are kept.'
    case 'offline_permission_expired':
      return 'Saved offline permission has expired. Keep this app’s data and contact your manager or support. Renewal is not available in this app version.'
    case 'pin_confirmation_mismatch':
      return 'The PIN confirmation did not match. Try again in the Android dialog.'
    case 'pin_kdf_unsupported':
      return 'This device cannot provide the required PIN protection. Keep saved records and contact your manager or support.'
    case 'offline_shift_required':
      return 'An open counter shift is required. Check offline status before continuing.'
    case 'offline_preparation_uncertain':
      return 'Setup needs confirmation. Keep the saved request and retry that same setup; do not start a replacement shift or change its opening cash.'
    case 'offline_context_changed':
      return 'The staff, counter or shift has changed. Check account access and offline status before continuing.'
    case 'pin_unlock_required':
      return 'Unlock using the Android PIN dialog to check prepared access.'
    case 'native_pin_cancelled':
      return 'Android PIN dialog cancelled. No replacement setup request was started.'
    case 'pin_incorrect':
      return 'The PIN was not accepted. Use the Android dialog to try again.'
    case 'pin_locked':
      return 'Local unlock is locked after unsuccessful attempts. Connect and ask your manager for recovery.'
    case 'pin_online_reset_required':
      return 'Connect to recover local access with your manager. Saved device records are kept.'
    case 'clock_source_blocked':
      return 'Device time could not be verified. Keep this app’s data and contact your manager or support. Automatic time recovery is not available.'
    default:
      return nativeAccessError(error)
  }
}
export function openingCashToFils(value: string): number | null {
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(value.trim())) return null
  const [whole, fraction = ''] = value.trim().split('.')
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(result) && result >= 0 && result <= 100000000 ? result : null
}
export async function readOfflineState(): Promise<NativeOfflineState> {
  requireNativeAccess()
  return parseOfflineState(await ledger.getOfflineState())
}
export async function openNativeOfflineShift(openingCashFils: number): Promise<NativeOfflineState> {
  requireNativeAccess()
  if (!Number.isSafeInteger(openingCashFils) || openingCashFils < 0 || openingCashFils > 100000000)
    throw new Error('invalid_native_input')
  return parseOfflineState(await ledger.openOfflineShift({ openingCashFils }))
}
export async function prepareNativeOffline(): Promise<NativeOfflineState> {
  requireNativeAccess()
  return parseOfflineState(await ledger.prepareOffline())
}
export async function unlockNativeOffline(): Promise<NativeOfflineState> {
  requireNativeAccess()
  return parseOfflineState(await ledger.unlockOffline())
}
export async function lockNativeOffline(): Promise<NativeOfflineState> {
  requireNativeAccess()
  return parseOfflineState(await ledger.lockOffline())
}

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

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
  getBundleRecoveryState(): Promise<unknown>
  recoverMissingOfflineBundle(input: { authorityId: string }): Promise<unknown>
  addListener(
    eventName: 'nativeCheckoutLocked',
    listener: (event: unknown) => void
  ): Promise<PluginListenerHandle>
  getReceipt(input: { id: string }): Promise<unknown>
  getCheckoutState(): Promise<unknown>
  quoteBasket(input: NativeQuoteInput): Promise<unknown>
  beginPaymentIntent(input: { intentId: string; request: NativeCheckoutRequest }): Promise<unknown>
  getPaymentIntent(input: { intentId: string }): Promise<unknown>
  freezePaymentIntentForManager(input: { intentId: string }): Promise<unknown>
  confirmPaymentIntent(input: { intentId: string }): Promise<unknown>
  cancelUncollectedIntent(input: { intentId: string; reason: string }): Promise<unknown>
  getReconciliationState(): Promise<unknown>
  reconcileOffline(): Promise<unknown>
  finishOfflineAuthority(input: { authorityId: string }): Promise<unknown>
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
        'offline_allocation_finished',
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
    case 'offline_allocation_finished':
      return 'This invoice allocation is finished and cannot be used for new sales. Records are kept. Use Upload saved records for any pending confirmation. Preparing the next allocation is a separate step.'
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

export type NativeReconciliationState = {
  schemaVersion: 1
  pendingReceipts: number
  unsealedAuthorities: number
  pendingSeals: number
  confirmedSeals: number
  status: 'idle' | 'pending' | 'attention'
  noticeCode: string | null
}
export function parseReconciliationState(value: unknown): NativeReconciliationState {
  const result = record(value, [
    'schemaVersion',
    'pendingReceipts',
    'unsealedAuthorities',
    'pendingSeals',
    'confirmedSeals',
    'status',
    'noticeCode',
  ])
  if (
    result.schemaVersion !== 1 ||
    !['idle', 'pending', 'attention'].includes(String(result.status)) ||
    ['pendingReceipts', 'unsealedAuthorities', 'pendingSeals', 'confirmedSeals'].some(
      (key) => !Number.isSafeInteger(result[key]) || Number(result[key]) < 0
    ) ||
    (result.noticeCode !== null &&
      (typeof result.noticeCode !== 'string' || !/^[a-z_]{1,100}$/.test(result.noticeCode)))
  )
    throw new Error('invalid_native_response')
  return result as NativeReconciliationState
}
export function nativeReconciliationError(error: unknown): string {
  switch (nativeOfflineErrorCode(error)) {
    case 'offline_reconciliation_required':
      return 'Saved records need reconciliation. Keep this app’s data and check the original payment records before taking any further payment.'
    case 'offline_upload_uncertain':
      return 'Receipt upload was not confirmed. Saved receipts remain on this device. Retry uploading these same records; do not collect payment again.'
    case 'offline_seal_uncertain':
      return 'The finished allocation has not been confirmed by the server. Keep its saved declaration and retry Upload saved records. Do not create a replacement declaration.'
    case 'native_storage_unavailable':
      return 'Saved records could not be read or updated. Keep this app’s data and contact your manager or support. Do not reinstall.'
    case 'native_pin_cancelled':
      return 'Android PIN dialog cancelled. No new finish request was confirmed.'
    case 'pin_incorrect':
    case 'pin_locked':
    case 'pin_online_reset_required':
    case 'clock_source_blocked':
    case 'native_session_expired':
    case 'native_network_unavailable':
    case 'native_authentication_failed':
      return nativeOfflineError(error)
    default:
      return 'Reconciliation could not be confirmed. Keep this app’s saved records and contact your manager or support.'
  }
}
export function knownReconciliationNotice(code: string | null): boolean {
  return (
    code === null ||
    [
      'offline_reconciliation_required',
      'offline_upload_uncertain',
      'offline_seal_uncertain',
      'native_storage_unavailable',
    ].includes(code)
  )
}
export async function readNativeReconciliation(): Promise<NativeReconciliationState> {
  requireNativeAccess()
  return parseReconciliationState(await ledger.getReconciliationState())
}
export async function reconcileNativeOffline(): Promise<NativeReconciliationState> {
  requireNativeAccess()
  return parseReconciliationState(await ledger.reconcileOffline())
}
export async function finishNativeOfflineAuthority(
  authorityId: string
): Promise<NativeReconciliationState> {
  requireNativeAccess()
  if (!uuid(authorityId)) throw new Error('invalid_native_input')
  return parseReconciliationState(await ledger.finishOfflineAuthority({ authorityId }))
}

export type NativeCustomer = { name: string; address: string; trn: string | null }
export type NativeCheckoutRequest = {
  authorityId: string
  serviceType: 'dine_in' | 'takeaway' | 'delivery'
  customer: NativeCustomer | null
  lines: { productId: string; quantityMilli: number }[]
  cashTenderedFils: number
  recordedCardFils: number
  presentedTotalFils: number
}
export type NativeQuoteInput = Omit<
  NativeCheckoutRequest,
  'cashTenderedFils' | 'recordedCardFils' | 'presentedTotalFils'
> & {
  tenderMode: 'cash' | 'card' | 'mixed'
  cashTenderedFils: number | null
  recordedCardFils: number | null
}
export type NativeCheckoutLine = {
  lineNumber: number
  productId: string
  name: string
  unit: 'piece' | 'pack' | 'kg'
  quantityMilli: number
  unitPriceFils: number
  taxRateBps: number
  grossFils: number
  netFils: number
  taxFils: number
}
export type NativeQuote = {
  schemaVersion: 1
  authorityId: string
  request: NativeCheckoutRequest
  lines: NativeCheckoutLine[]
  totals: { grossFils: number; netFils: number; taxFils: number }
  payments: { method: 'cash' | 'card'; amountFils: number }[]
  cashTenderedFils: number
  changeFils: number
  requiresBuyerDetails: boolean
}
export type NativeReceipt = Omit<
  NativeQuote,
  'authorityId' | 'request' | 'requiresBuyerDetails'
> & {
  id: string
  documentNumber: string
  issuedAt: string
  serviceType: NativeCheckoutRequest['serviceType']
  customer: NativeCustomer | null
  merchant: { legalName: string; branchName: string; address: string; phone: string; trn: string }
  syncState: 'pending' | 'acknowledged'
}
export type NativeIntent = {
  schemaVersion: 1
  intentId: string
  createdAt: string
  request: NativeCheckoutRequest
  quote: NativeQuote
  canConfirm: boolean
  canCancel: boolean
  reasonCode: string | null
  receipt: NativeReceipt | null
} & (
  | { state: 'payment_confirmation_required' | 'committed' | 'cancelled'; managerReview?: never }
  | {
      state: 'frozen_for_manager'
      managerReview: { freezeId: string; proofSha256: string; status: 'saved_locally' }
    }
)
export type NativeCheckoutContext = {
  authorityId: string
  actorId: string
  branchId: string
  deviceId: string
  shiftId: string
  branchName: string
  snapshotId: string
  snapshotCreatedAt: string
  expiresAt: string
  permissions: { cash: boolean; recordedCard: boolean; mixedTender: boolean }
  products: {
    id: string
    name: string
    category: string
    unit: NativeCheckoutLine['unit']
    unitPriceFils: number
  }[]
}
export type NativeCheckoutState = {
  schemaVersion: 1
  canIssue: boolean
  reasonCode: string | null
  context: NativeCheckoutContext | null
  pendingIntentId: string | null
  lastReceiptId: string | null
  unresolvedIntent: NativeIntent | null
  lastReceipt: NativeReceipt | null
}
const amountValue = (value: unknown, min = 0, max = 100000000): value is number =>
  Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
const boundedText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) &&
  Number.isFinite(Date.parse(value))
const reasonCode = (value: unknown): boolean =>
  value === null || (typeof value === 'string' && /^[a-z_]{1,100}$/.test(value))
const serviceType = (value: unknown): boolean =>
  ['dine_in', 'takeaway', 'delivery'].includes(String(value))
const unitType = (value: unknown): boolean => ['piece', 'pack', 'kg'].includes(String(value))
function invalidCheckout(): never {
  throw new Error('invalid_native_response')
}
function parseCustomer(value: unknown): NativeCustomer | null {
  if (value === null) return null
  const c = record(value, ['name', 'address', 'trn'])
  if (
    !boundedText(c.name, 200) ||
    !boundedText(c.address, 400) ||
    (c.trn !== null && (typeof c.trn !== 'string' || !/^\d{15}$/.test(c.trn)))
  )
    invalidCheckout()
  return c as NativeCustomer
}
export function parseCheckoutRequest(value: unknown): NativeCheckoutRequest {
  const r = record(value, [
    'authorityId',
    'serviceType',
    'customer',
    'lines',
    'cashTenderedFils',
    'recordedCardFils',
    'presentedTotalFils',
  ])
  if (
    !uuid(r.authorityId) ||
    !serviceType(r.serviceType) ||
    !Array.isArray(r.lines) ||
    r.lines.length < 1 ||
    r.lines.length > 200 ||
    !amountValue(r.cashTenderedFils) ||
    !amountValue(r.recordedCardFils) ||
    !amountValue(r.presentedTotalFils, 1)
  )
    invalidCheckout()
  parseCustomer(r.customer)
  const ids = new Set<string>()
  for (const value of r.lines) {
    const line = record(value, ['productId', 'quantityMilli'])
    if (
      !uuid(line.productId) ||
      ids.has(line.productId) ||
      !amountValue(line.quantityMilli, 1, 1000000)
    )
      invalidCheckout()
    ids.add(line.productId)
  }
  return r as NativeCheckoutRequest
}
export function checkoutRequestKey(request: NativeCheckoutRequest): string {
  return JSON.stringify([
    request.authorityId,
    request.serviceType,
    request.customer && [request.customer.name, request.customer.address, request.customer.trn],
    request.lines.map((line) => [line.productId, line.quantityMilli]),
    request.cashTenderedFils,
    request.recordedCardFils,
    request.presentedTotalFils,
  ])
}
export function quoteInputKey(input: NativeQuoteInput): string {
  return JSON.stringify([
    input.authorityId,
    input.serviceType,
    input.customer && [input.customer.name, input.customer.address, input.customer.trn],
    input.lines.map((line) => [line.productId, line.quantityMilli]),
    input.tenderMode,
    input.cashTenderedFils,
    input.recordedCardFils,
  ])
}
function parseFinancialFields(r: Record<string, unknown>) {
  if (
    !Array.isArray(r.lines) ||
    r.lines.length < 1 ||
    r.lines.length > 200 ||
    !Array.isArray(r.payments) ||
    r.payments.length < 1 ||
    r.payments.length > 2 ||
    !amountValue(r.cashTenderedFils) ||
    !amountValue(r.changeFils)
  )
    invalidCheckout()
  const ids = new Set<string>()
  for (let i = 0; i < r.lines.length; i++) {
    const line = record(r.lines[i], [
      'lineNumber',
      'productId',
      'name',
      'unit',
      'quantityMilli',
      'unitPriceFils',
      'taxRateBps',
      'grossFils',
      'netFils',
      'taxFils',
    ])
    if (
      line.lineNumber !== i + 1 ||
      !uuid(line.productId) ||
      ids.has(line.productId) ||
      !boundedText(line.name, 240) ||
      !unitType(line.unit) ||
      !amountValue(line.quantityMilli, 1, 1000000) ||
      (line.unit !== 'kg' && Number(line.quantityMilli) % 1000 !== 0) ||
      !amountValue(line.unitPriceFils) ||
      !amountValue(line.taxRateBps, 0, 10000) ||
      !amountValue(line.grossFils) ||
      !amountValue(line.netFils) ||
      !amountValue(line.taxFils) ||
      Number(line.netFils) + Number(line.taxFils) !== line.grossFils
    )
      invalidCheckout()
    ids.add(line.productId)
  }
  const totals = record(r.totals, ['grossFils', 'netFils', 'taxFils'])
  if (
    !amountValue(totals.grossFils, 1) ||
    !amountValue(totals.netFils) ||
    !amountValue(totals.taxFils) ||
    Number(totals.netFils) + Number(totals.taxFils) !== totals.grossFils
  )
    invalidCheckout()
  const typedLines = r.lines as NativeCheckoutLine[]
  if (
    typedLines.reduce((sum, line) => sum + line.grossFils, 0) !== totals.grossFils ||
    typedLines.reduce((sum, line) => sum + line.netFils, 0) !== totals.netFils ||
    typedLines.reduce((sum, line) => sum + line.taxFils, 0) !== totals.taxFils
  )
    invalidCheckout()
  const methods = new Set<string>()
  let applied = 0
  for (const value of r.payments) {
    const payment = record(value, ['method', 'amountFils'])
    if (
      !['cash', 'card'].includes(String(payment.method)) ||
      methods.has(String(payment.method)) ||
      !amountValue(payment.amountFils, 1)
    )
      invalidCheckout()
    methods.add(String(payment.method))
    applied += Number(payment.amountFils)
  }
  if (applied !== totals.grossFils) invalidCheckout()
  const cashApplied =
    (r.payments as NativeQuote['payments']).find((p) => p.method === 'cash')?.amountFils ?? 0
  if (Number(r.cashTenderedFils) - cashApplied !== r.changeFils) invalidCheckout()
}
export function parseNativeQuote(value: unknown): NativeQuote {
  const r = record(value, [
    'schemaVersion',
    'authorityId',
    'request',
    'lines',
    'totals',
    'payments',
    'cashTenderedFils',
    'changeFils',
    'requiresBuyerDetails',
  ])
  if (r.schemaVersion !== 1 || !uuid(r.authorityId) || typeof r.requiresBuyerDetails !== 'boolean')
    invalidCheckout()
  const request = parseCheckoutRequest(r.request)
  parseFinancialFields(r)
  if (
    request.authorityId !== r.authorityId ||
    request.presentedTotalFils !== (r.totals as NativeQuote['totals']).grossFils ||
    request.cashTenderedFils !== r.cashTenderedFils ||
    request.recordedCardFils !==
      ((r.payments as NativeQuote['payments']).find((p) => p.method === 'card')?.amountFils ?? 0) ||
    request.lines.length !== (r.lines as NativeCheckoutLine[]).length ||
    request.lines.some(
      (line, i) =>
        line.productId !== (r.lines as NativeCheckoutLine[])[i].productId ||
        line.quantityMilli !== (r.lines as NativeCheckoutLine[])[i].quantityMilli
    )
  )
    invalidCheckout()
  return r as NativeQuote
}
export function parseNativeReceipt(value: unknown): NativeReceipt {
  const r = record(value, [
    'schemaVersion',
    'id',
    'documentNumber',
    'issuedAt',
    'serviceType',
    'customer',
    'merchant',
    'lines',
    'totals',
    'payments',
    'cashTenderedFils',
    'changeFils',
    'syncState',
  ])
  if (
    r.schemaVersion !== 1 ||
    !uuid(r.id) ||
    !boundedText(r.documentNumber, 160) ||
    !timestamp(r.issuedAt) ||
    !serviceType(r.serviceType) ||
    !['pending', 'acknowledged'].includes(String(r.syncState))
  )
    invalidCheckout()
  parseCustomer(r.customer)
  parseFinancialFields(r)
  const merchant = record(r.merchant, ['legalName', 'branchName', 'address', 'phone', 'trn'])
  if (
    !boundedText(merchant.legalName, 200) ||
    !boundedText(merchant.branchName, 120) ||
    !boundedText(merchant.address, 400) ||
    !boundedText(merchant.phone, 30) ||
    typeof merchant.trn !== 'string' ||
    !/^\d{15}$/.test(merchant.trn)
  )
    invalidCheckout()
  return r as NativeReceipt
}
export function parseNativeIntent(value: unknown): NativeIntent {
  const frozen =
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { state?: unknown }).state === 'frozen_for_manager'
  const r = record(value, [
    'schemaVersion',
    'intentId',
    'state',
    'createdAt',
    'request',
    'quote',
    'canConfirm',
    'canCancel',
    'reasonCode',
    'receipt',
    ...(frozen ? ['managerReview'] : []),
  ])
  if (
    r.schemaVersion !== 1 ||
    !uuid(r.intentId) ||
    !['payment_confirmation_required', 'committed', 'cancelled', 'frozen_for_manager'].includes(
      String(r.state)
    ) ||
    !timestamp(r.createdAt) ||
    typeof r.canConfirm !== 'boolean' ||
    typeof r.canCancel !== 'boolean' ||
    !reasonCode(r.reasonCode)
  )
    invalidCheckout()
  if (frozen) {
    const review = record(r.managerReview, ['freezeId', 'proofSha256', 'status'])
    if (
      !uuid(review.freezeId) ||
      typeof review.proofSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(review.proofSha256) ||
      review.status !== 'saved_locally' ||
      r.reasonCode !== 'payment_frozen'
    )
      invalidCheckout()
  } else if (r.reasonCode === 'payment_frozen') invalidCheckout()
  const request = parseCheckoutRequest(r.request)
  const quote = parseNativeQuote(r.quote)
  if (
    checkoutRequestKey(request) !== checkoutRequestKey(quote.request) ||
    (r.state === 'committed' ? r.receipt === null : r.receipt !== null) ||
    (r.state !== 'payment_confirmation_required' && (r.canConfirm || r.canCancel))
  )
    invalidCheckout()
  if (r.receipt !== null) {
    const receipt = parseNativeReceipt(r.receipt)
    if (
      receipt.totals.grossFils !== quote.totals.grossFils ||
      receipt.serviceType !== request.serviceType ||
      JSON.stringify([receipt.customer?.name, receipt.customer?.address, receipt.customer?.trn]) !==
        JSON.stringify([
          request.customer?.name,
          request.customer?.address,
          request.customer?.trn,
        ]) ||
      receipt.cashTenderedFils !== quote.cashTenderedFils ||
      receipt.changeFils !== quote.changeFils ||
      JSON.stringify(
        receipt.lines.map((l) => [
          l.lineNumber,
          l.productId,
          l.name,
          l.unit,
          l.quantityMilli,
          l.unitPriceFils,
          l.taxRateBps,
          l.grossFils,
          l.netFils,
          l.taxFils,
        ])
      ) !==
        JSON.stringify(
          quote.lines.map((l) => [
            l.lineNumber,
            l.productId,
            l.name,
            l.unit,
            l.quantityMilli,
            l.unitPriceFils,
            l.taxRateBps,
            l.grossFils,
            l.netFils,
            l.taxFils,
          ])
        ) ||
      JSON.stringify(receipt.payments.map((p) => [p.method, p.amountFils])) !==
        JSON.stringify(quote.payments.map((p) => [p.method, p.amountFils]))
    )
      invalidCheckout()
  }
  return r as NativeIntent
}
export function parseNativeCheckoutState(value: unknown): NativeCheckoutState {
  const r = record(value, [
    'schemaVersion',
    'canIssue',
    'reasonCode',
    'context',
    'pendingIntentId',
    'lastReceiptId',
    'unresolvedIntent',
    'lastReceipt',
  ])
  if (r.schemaVersion !== 1 || typeof r.canIssue !== 'boolean' || !reasonCode(r.reasonCode))
    invalidCheckout()
  if (
    (r.pendingIntentId !== null && !uuid(r.pendingIntentId)) ||
    (r.lastReceiptId !== null && !uuid(r.lastReceiptId))
  )
    invalidCheckout()
  if (r.context !== null) {
    const c = record(r.context, [
      'authorityId',
      'actorId',
      'branchId',
      'deviceId',
      'shiftId',
      'branchName',
      'snapshotId',
      'snapshotCreatedAt',
      'expiresAt',
      'permissions',
      'products',
    ])
    if (
      ['authorityId', 'actorId', 'branchId', 'deviceId', 'shiftId', 'snapshotId'].some(
        (key) => !uuid(c[key])
      ) ||
      !boundedText(c.branchName, 120) ||
      !timestamp(c.snapshotCreatedAt) ||
      !timestamp(c.expiresAt) ||
      !Array.isArray(c.products) ||
      c.products.length < 1 ||
      c.products.length > 2000
    )
      invalidCheckout()
    const permissions = record(c.permissions, ['cash', 'recordedCard', 'mixedTender'])
    if (Object.values(permissions).some((v) => typeof v !== 'boolean')) invalidCheckout()
    const ids = new Set<string>()
    for (const value of c.products) {
      const product = record(value, ['id', 'name', 'category', 'unit', 'unitPriceFils'])
      if (
        !uuid(product.id) ||
        ids.has(product.id) ||
        !boundedText(product.name, 240) ||
        !boundedText(product.category, 120) ||
        !unitType(product.unit) ||
        !amountValue(product.unitPriceFils)
      )
        invalidCheckout()
      ids.add(product.id)
    }
  }
  if (
    r.unresolvedIntent !== null &&
    !['payment_confirmation_required', 'frozen_for_manager'].includes(
      parseNativeIntent(r.unresolvedIntent).state
    )
  )
    invalidCheckout()
  if (
    r.unresolvedIntent !== null &&
    parseNativeIntent(r.unresolvedIntent).intentId !== r.pendingIntentId
  )
    invalidCheckout()
  if (r.lastReceipt !== null && parseNativeReceipt(r.lastReceipt).id !== r.lastReceiptId)
    invalidCheckout()
  if (r.canIssue && (r.context === null || r.pendingIntentId !== null || r.reasonCode !== null))
    invalidCheckout()
  return r as NativeCheckoutState
}
export function quantityToMilli(value: string, unit: NativeCheckoutLine['unit']): number | null {
  if (!/^\d{1,4}(?:\.\d{1,3})?$/.test(value.trim())) return null
  const [whole, fraction = ''] = value.trim().split('.')
  const result = Number(whole) * 1000 + Number(fraction.padEnd(3, '0'))
  return amountValue(result, 1, 1000000) && (unit === 'kg' || result % 1000 === 0) ? result : null
}
export function nativeCheckoutError(error: unknown): string {
  switch (nativeOfflineErrorCode(error)) {
    case 'unsupported_text':
      return 'Buyer details contain an unsupported hidden character. New billing cannot continue. Keep any saved payment for manager review and do not collect again.'
    case 'payment_frozen':
      return 'This payment is permanently frozen on this device. Manager review has not been sent. Do not collect again, issue a bill or declare it cancelled.'
    case 'native_session_expired':
      return 'Sign in with the original staff account to review this payment. Saved records remain on this device.'
    case 'pin_unlock_required':
      return 'Unlock payment review using the Android PIN dialog. Do not collect payment again.'
    case 'clock_expired':
      return 'The saved permission has expired. New collection is paused. If money was already received, keep the original payment and contact your manager.'
    case 'clock_source_blocked':
      return 'Device time could not be verified. Keep the original payment and contact your manager; do not collect payment again.'
    case 'authority_closed':
      return 'This allocation is finished. Review saved payments and receipts; do not start another collection with it.'
    case 'payment_reconciliation_required':
      return 'A saved payment needs checking. Resolve that original payment before starting another sale.'
    case 'presented_total_changed':
      return 'The bill total no longer matches the saved menu. Review a fresh native quote before collecting payment.'
    case 'authority_exhausted':
      return 'This allocation has reached its limit. New payments are paused; keep saved records and contact your manager.'
    case 'buyer_details_required':
      return 'Buyer name and address are required for this bill. Complete them before saving the payment step.'
    case 'tender_not_authorized':
      return 'This payment method is not permitted by the current offline allocation.'
    case 'intent_conflict':
      return 'The saved payment does not match this request. Keep its original identity and ask your manager to reconcile it.'
    case 'intent_missing':
      return 'No saved payment was returned for this reference. Do not collect payment or start a replacement until the device state has been checked.'
    case 'native_checkout_not_enabled':
    case 'offline_checkout_disabled':
      return 'New sales are not enabled in this app build. Saved payments and receipts remain available for review.'
    default:
      return 'The payment step could not be confirmed. Keep the original record. If money may have been collected, check it before doing anything else.'
  }
}
export async function readNativeCheckout(): Promise<NativeCheckoutState> {
  requireNativeAccess()
  return parseNativeCheckoutState(await ledger.getCheckoutState())
}
export async function quoteNativeBasket(input: NativeQuoteInput): Promise<NativeQuote> {
  requireNativeAccess()
  const result = parseNativeQuote(await ledger.quoteBasket(input))
  const req = result.request
  if (
    req.authorityId !== input.authorityId ||
    req.serviceType !== input.serviceType ||
    JSON.stringify([req.customer?.name, req.customer?.address, req.customer?.trn]) !==
      JSON.stringify([input.customer?.name, input.customer?.address, input.customer?.trn]) ||
    JSON.stringify(req.lines.map((l) => [l.productId, l.quantityMilli])) !==
      JSON.stringify(input.lines.map((l) => [l.productId, l.quantityMilli])) ||
    (input.cashTenderedFils !== null && req.cashTenderedFils !== input.cashTenderedFils) ||
    (input.recordedCardFils !== null && req.recordedCardFils !== input.recordedCardFils) ||
    (input.tenderMode === 'cash' && req.recordedCardFils !== 0) ||
    (input.tenderMode === 'card' &&
      (req.cashTenderedFils !== 0 || req.recordedCardFils !== req.presentedTotalFils)) ||
    (input.tenderMode === 'mixed' &&
      (req.recordedCardFils < 1 || req.recordedCardFils >= req.presentedTotalFils))
  )
    invalidCheckout()
  return result
}
export async function beginNativePaymentIntent(
  intentId: string,
  request: NativeCheckoutRequest
): Promise<NativeIntent> {
  requireNativeAccess()
  if (!uuid(intentId)) throw new Error('invalid_native_input')
  parseCheckoutRequest(request)
  const result = parseNativeIntent(await ledger.beginPaymentIntent({ intentId, request }))
  if (
    result.intentId !== intentId ||
    checkoutRequestKey(result.request) !== checkoutRequestKey(request)
  )
    invalidCheckout()
  return result
}
export async function readNativePaymentIntent(intentId: string): Promise<NativeIntent> {
  requireNativeAccess()
  if (!uuid(intentId)) throw new Error('invalid_native_input')
  const result = parseNativeIntent(await ledger.getPaymentIntent({ intentId }))
  if (result.intentId !== intentId) invalidCheckout()
  return result
}
export async function confirmNativePaymentIntent(intentId: string): Promise<NativeIntent> {
  requireNativeAccess()
  if (!uuid(intentId)) throw new Error('invalid_native_input')
  const result = parseNativeIntent(await ledger.confirmPaymentIntent({ intentId }))
  if (result.intentId !== intentId || result.state !== 'committed') invalidCheckout()
  return result
}
export async function cancelNativeUncollectedIntent(
  intentId: string,
  reason: string
): Promise<NativeIntent> {
  requireNativeAccess()
  if (!uuid(intentId) || !boundedText(reason, 240)) throw new Error('invalid_native_input')
  const result = parseNativeIntent(await ledger.cancelUncollectedIntent({ intentId, reason }))
  if (result.intentId !== intentId) invalidCheckout()
  return result
}

export function knownCheckoutReason(code: string | null): boolean {
  return (
    code === null ||
    [
      'native_checkout_not_enabled',
      'native_session_expired',
      'pin_unlock_required',
      'clock_expired',
      'clock_source_blocked',
      'authority_closed',
      'authority_exhausted',
      'payment_reconciliation_required',
      'payment_frozen',
      'unsupported_text',
    ].includes(code)
  )
}

export async function readNativeReceipt(id: string): Promise<NativeReceipt> {
  requireNativeAccess()
  if (!uuid(id)) throw new Error('invalid_native_input')
  const result = parseNativeReceipt(await ledger.getReceipt({ id }))
  if (result.id !== id) invalidCheckout()
  return result
}

export async function subscribeNativeCheckoutLock(
  onLock: () => void
): Promise<PluginListenerHandle> {
  requireNativeAccess()
  return ledger.addListener('nativeCheckoutLocked', () => onLock())
}

export type NativeBundleRecoveryState = {
  schemaVersion: 1
  status: 'not_needed' | 'available' | 'blocked' | 'retained'
  authorityId: string | null
  reasonCode: string | null
  canRecover: boolean
}
export function parseBundleRecoveryState(value: unknown): NativeBundleRecoveryState {
  const r = record(value, ['schemaVersion', 'status', 'authorityId', 'reasonCode', 'canRecover'])
  if (
    r.schemaVersion !== 1 ||
    !['not_needed', 'available', 'blocked', 'retained'].includes(String(r.status)) ||
    (r.authorityId !== null && !uuid(r.authorityId)) ||
    !reasonCode(r.reasonCode) ||
    typeof r.canRecover !== 'boolean' ||
    r.canRecover !== (r.status === 'available') ||
    (['available', 'retained'].includes(String(r.status)) && r.authorityId === null)
  )
    invalidCheckout()
  return r as NativeBundleRecoveryState
}
export function knownBundleRecoveryReason(code: string | null): boolean {
  return (
    code === null ||
    [
      'offline_recovery_uncertain',
      'offline_not_configured',
      'previous_authority_unresolved',
      'offline_allocation_active',
      'payment_reconciliation_required',
      'native_storage_unavailable',
      'offline_context_changed',
      'native_network_unavailable',
    ].includes(code)
  )
}
export function nativeBundleRecoveryError(error: unknown): string {
  switch (nativeOfflineErrorCode(error)) {
    case 'offline_not_configured':
      return 'Recovery is not configured in this app build. Keep this app’s data and ask your manager for the approved app update.'
    case 'previous_authority_unresolved':
      return 'A previous allocation still needs reconciliation. Keep its records and use Upload saved records; do not reserve replacement numbers.'
    case 'offline_allocation_active':
      return 'The original allocation is already saved on this device. Missing-allocation recovery is not needed; review its current status in Prepare offline access.'
    case 'offline_recovery_uncertain':
      return 'Recovery was not confirmed. Check the original allocation’s saved status before retrying; do not reserve replacement invoice numbers.'
    case 'payment_reconciliation_required':
      return 'A saved payment needs checking. Resolve that original payment in Counter before recovering an allocation.'
    case 'native_storage_unavailable':
      return 'The saved recovery record could not be read. Keep this app’s data and contact your manager or support.'
    case 'offline_context_changed':
      return 'The allocation no longer matches this recovery request. Keep the original record and contact your manager or support.'
    case 'native_network_unavailable':
      return 'Connect to the internet, then check the original recovery status before retrying.'
    default:
      return 'Recovery could not be verified. Keep this app’s data and check the original allocation status. Do not reinstall or reserve replacement numbers.'
  }
}
export async function readNativeBundleRecovery(): Promise<NativeBundleRecoveryState> {
  requireNativeAccess()
  return parseBundleRecoveryState(await ledger.getBundleRecoveryState())
}
export async function recoverNativeMissingBundle(
  authorityId: string
): Promise<NativeBundleRecoveryState> {
  requireNativeAccess()
  if (!uuid(authorityId)) throw new Error('invalid_native_input')
  const result = parseBundleRecoveryState(await ledger.recoverMissingOfflineBundle({ authorityId }))
  if (result.authorityId !== authorityId || result.status !== 'retained' || result.canRecover)
    invalidCheckout()
  return result
}

export async function freezeNativePaymentForManager(intentId: string): Promise<NativeIntent> {
  requireNativeAccess()
  if (!uuid(intentId)) throw new Error('invalid_native_input')
  const result = parseNativeIntent(await ledger.freezePaymentIntentForManager({ intentId }))
  if (result.intentId !== intentId || result.state !== 'frozen_for_manager') invalidCheckout()
  return result
}

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
vi.mock('../../../apps/android-pos/node_modules/react', async () => await import('react'))
const bridge = vi.hoisted(() => ({
  subscribeNativeCheckoutLock: vi.fn(),
  readNativeCheckout: vi.fn(),
  quoteNativeBasket: vi.fn(),
  beginNativePaymentIntent: vi.fn(),
  readNativePaymentIntent: vi.fn(),
  confirmNativePaymentIntent: vi.fn(),
  cancelNativeUncollectedIntent: vi.fn(),
  freezeNativePaymentForManager: vi.fn(),
  unlockNativeOffline: vi.fn(),
}))
vi.mock('../../../apps/android-pos/src/native', async () => ({
  ...(await vi.importActual('../../../apps/android-pos/src/native')),
  ...bridge,
}))
import NativeCounter from '../../../apps/android-pos/src/NativeCounter'
import { state, quote, intent, receipt, id } from './fixtures/native-checkout'
const props = () => ({
  available: true,
  ready: true,
  revision: 1,
  operationLock: { current: false },
  onBusyChange: vi.fn(),
  onHoldChange: vi.fn(),
  onRecordsChanged: vi.fn(),
  onGoToDevice: vi.fn(),
})
beforeEach(() => {
  bridge.subscribeNativeCheckoutLock.mockResolvedValue({
    remove: vi.fn().mockResolvedValue(undefined),
  })
  bridge.readNativeCheckout.mockResolvedValue(state)
  bridge.quoteNativeBasket.mockResolvedValue(quote)
  bridge.beginNativePaymentIntent.mockImplementation(async (intentId, request) => ({
    ...intent,
    intentId,
    request,
    quote: { ...quote, request },
  }))
  bridge.confirmNativePaymentIntent.mockImplementation(async (intentId) => ({
    ...intent,
    intentId,
    state: 'committed',
    canConfirm: false,
    canCancel: false,
    receipt,
  }))
  bridge.unlockNativeOffline.mockResolvedValue({})
})
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
async function review() {
  await screen.findByRole('heading', { name: 'Choose items' })
  fireEvent.change(screen.getByLabelText('QA Milk cake weight in kg'), { target: { value: '1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Review bill' }))
  await screen.findByRole('button', { name: 'Save payment step before collection' })
}
async function begin() {
  await review()
  fireEvent.click(screen.getByRole('button', { name: 'Save payment step before collection' }))
  await screen.findByRole('heading', { name: 'Review the saved payment' })
}
describe('real native counter UI flow', () => {
  it('uses a native quote and persists a single exact intent before enabling receipt confirmation', async () => {
    render(<NativeCounter {...props()} />)
    await begin()
    expect(bridge.beginNativePaymentIntent).toHaveBeenCalledTimes(1)
    expect(bridge.beginNativePaymentIntent.mock.calls[0][1]).toEqual(quote.request)
    expect(bridge.confirmNativePaymentIntent).not.toHaveBeenCalled()
    const button = screen.getByRole('button', { name: 'Confirm received payment & save receipt' })
    expect(button).toBeDisabled()
    fireEvent.click(
      screen.getByLabelText('I checked that the exact payment shown above was received.')
    )
    fireEvent.click(button)
    await screen.findByRole('heading', { name: receipt.documentNumber })
    expect(bridge.confirmNativePaymentIntent).toHaveBeenCalledWith(
      bridge.beginNativePaymentIntent.mock.calls[0][0]
    )
    expect(screen.getByText(/Saved on this device · awaiting sync/)).toBeVisible()
  })
  it('allows preview but never collection when native release gate is paused', async () => {
    bridge.readNativeCheckout.mockResolvedValue({
      ...state,
      canIssue: false,
      reasonCode: 'native_checkout_not_enabled',
    })
    render(<NativeCounter {...props()} />)
    await review()
    expect(
      screen.getByRole('button', { name: 'Save payment step before collection' })
    ).toBeDisabled()
    expect(bridge.beginNativePaymentIntent).not.toHaveBeenCalled()
  })
  it('discards the quote as soon as the quantity or service changes', async () => {
    render(<NativeCounter {...props()} />)
    await review()
    fireEvent.change(screen.getByLabelText('Order type'), { target: { value: 'delivery' } })
    expect(screen.queryByRole('button', { name: 'Save payment step before collection' })).toBeNull()
    expect(bridge.beginNativePaymentIntent).not.toHaveBeenCalled()
  })
  it('does not expose locked intent details and blocks all new basket work', async () => {
    bridge.readNativeCheckout.mockResolvedValue({
      ...state,
      canIssue: false,
      pendingIntentId: id(8),
      reasonCode: 'pin_unlock_required',
    })
    const p = props()
    render(<NativeCounter {...p} />)
    await screen.findByRole('heading', { name: 'Saved payment needs checking' })
    expect(screen.queryByRole('heading', { name: 'Choose items' })).toBeNull()
    expect(screen.queryByText('QA Milk cake')).toBeNull()
    expect(p.onHoldChange).toHaveBeenLastCalledWith(true)
    bridge.readNativeCheckout.mockResolvedValue({
      ...state,
      canIssue: false,
      pendingIntentId: id(8),
      unresolvedIntent: intent,
      reasonCode: 'payment_reconciliation_required',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock payment review' }))
    await screen.findByRole('heading', { name: 'Review the saved payment' })
    expect(bridge.unlockNativeOffline).toHaveBeenCalledTimes(1)
  })
  it('recovers lost commit acknowledgement by reading the original intent without collecting twice', async () => {
    bridge.confirmNativePaymentIntent.mockRejectedValue(new Error('native_storage_unavailable'))
    render(<NativeCounter {...props()} />)
    await begin()
    const intentId = bridge.beginNativePaymentIntent.mock.calls[0][0]
    fireEvent.click(
      screen.getByLabelText('I checked that the exact payment shown above was received.')
    )
    fireEvent.click(screen.getByRole('button', { name: 'Confirm received payment & save receipt' }))
    await screen.findByRole('alert')
    bridge.readNativePaymentIntent.mockResolvedValue({
      ...intent,
      intentId,
      state: 'committed',
      canConfirm: false,
      canCancel: false,
      receipt,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Check saved payment' }))
    await screen.findByRole('heading', { name: receipt.documentNumber })
    expect(bridge.readNativePaymentIntent).toHaveBeenCalledWith(intentId)
    expect(bridge.confirmNativePaymentIntent).toHaveBeenCalledTimes(1)
    expect(bridge.beginNativePaymentIntent).toHaveBeenCalledTimes(1)
  })
  it('requires exact no-money consent and a reason before cancellation while issuance paused', async () => {
    const saved = { ...intent, canConfirm: false, reasonCode: 'native_checkout_not_enabled' }
    bridge.readNativeCheckout.mockResolvedValue({
      ...state,
      canIssue: false,
      pendingIntentId: id(8),
      unresolvedIntent: saved,
      reasonCode: 'payment_reconciliation_required',
    })
    bridge.cancelNativeUncollectedIntent.mockResolvedValue({
      ...saved,
      state: 'cancelled',
      canCancel: false,
    })
    render(<NativeCounter {...props()} />)
    await screen.findByRole('heading', { name: 'Review the saved payment' })
    fireEvent.click(screen.getByText('No money was received'))
    const cancel = screen.getByRole('button', { name: 'Cancel uncollected payment' })
    expect(cancel).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Reason for no-money cancellation'), {
      target: { value: 'Customer left before payment' },
    })
    fireEvent.click(screen.getByLabelText('I checked that no money was received.'))
    fireEvent.click(cancel)
    await screen.findByText(/saved payment was cancelled/)
    expect(bridge.cancelNativeUncollectedIntent).toHaveBeenCalledWith(
      id(8),
      'Customer left before payment'
    )
    expect(bridge.confirmNativePaymentIntent).not.toHaveBeenCalled()
  })
  it('permits required buyer details when the native quote contains the complete buyer', async () => {
    const customer = { name: 'QA Buyer', address: 'QA Address', trn: null }
    bridge.quoteNativeBasket.mockResolvedValue({
      ...quote,
      requiresBuyerDetails: true,
      request: { ...quote.request, customer },
    })
    render(<NativeCounter {...props()} />)
    await screen.findByRole('heading', { name: 'Choose items' })
    fireEvent.click(screen.getByText('Customer details'))
    fireEvent.change(screen.getByLabelText('Customer name'), { target: { value: customer.name } })
    fireEvent.change(screen.getByLabelText('Customer address'), {
      target: { value: customer.address },
    })
    await review()
    expect(
      screen.getByRole('button', { name: 'Save payment step before collection' })
    ).toBeEnabled()
  })
  it('hides old private details immediately when account scope starts changing', async () => {
    bridge.readNativeCheckout.mockResolvedValue({
      ...state,
      canIssue: false,
      pendingIntentId: id(8),
      unresolvedIntent: intent,
      reasonCode: 'payment_reconciliation_required',
    })
    const p = props()
    const r = render(<NativeCounter {...p} />)
    await screen.findByRole('heading', { name: 'Review the saved payment' })
    r.rerender(<NativeCounter {...p} ready={false} revision={2} />)
    expect(screen.queryByRole('heading', { name: 'Review the saved payment' })).toBeNull()
    expect(screen.queryByText('QA Milk cake')).toBeNull()
  })
  it('does not accept a delayed quote from an earlier account revision', async () => {
    let resolve!: (v: typeof quote) => void
    bridge.quoteNativeBasket.mockReturnValue(
      new Promise((r) => {
        resolve = r
      })
    )
    const p = props()
    const rendered = render(<NativeCounter {...p} />)
    await screen.findByRole('heading', { name: 'Choose items' })
    fireEvent.change(screen.getByLabelText('QA Milk cake weight in kg'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Review bill' }))
    rendered.rerender(<NativeCounter {...p} ready={false} revision={2} />)
    await act(async () => resolve(quote))
    expect(screen.queryByRole('button', { name: 'Save payment step before collection' })).toBeNull()
  })
  it('unknown native reason cannot enable cancel or confirm', async () => {
    bridge.readNativeCheckout.mockResolvedValue({
      ...state,
      canIssue: false,
      pendingIntentId: id(8),
      unresolvedIntent: { ...intent, reasonCode: 'unexpected_new_reason' },
      reasonCode: 'payment_reconciliation_required',
    })
    render(<NativeCounter {...props()} />)
    await screen.findByRole('heading', { name: 'Review the saved payment' })
    expect(
      screen.getByRole('button', { name: 'Confirm received payment & save receipt' })
    ).toBeDisabled()
    expect(bridge.cancelNativeUncollectedIntent).not.toHaveBeenCalled()
  })
  it('retries an uncertain missing begin with its original ID and request only', async () => {
    bridge.beginNativePaymentIntent.mockRejectedValueOnce(new Error('native_storage_unavailable'))
    render(<NativeCounter {...props()} />)
    await review()
    fireEvent.click(screen.getByRole('button', { name: 'Save payment step before collection' }))
    await screen.findByRole('alert')
    const original = bridge.beginNativePaymentIntent.mock.calls[0]
    bridge.readNativePaymentIntent.mockRejectedValueOnce(new Error('intent_missing'))
    fireEvent.click(screen.getByRole('button', { name: 'Check saved payment' }))
    const retry = await screen.findByRole('button', { name: 'Retry saving this same payment step' })
    expect(screen.queryByRole('heading', { name: 'Choose items' })).toBeNull()
    fireEvent.click(retry)
    await screen.findByRole('heading', { name: 'Review the saved payment' })
    expect(bridge.beginNativePaymentIntent.mock.calls[1]).toEqual(original)
  })
  it('clears same-scope consent on native lock and never restores it after unlock', async () => {
    bridge.readNativeCheckout.mockResolvedValue({
      ...state,
      canIssue: false,
      pendingIntentId: id(8),
      unresolvedIntent: intent,
      reasonCode: 'payment_reconciliation_required',
    })
    render(<NativeCounter {...props()} />)
    await screen.findByRole('heading', { name: 'Review the saved payment' })
    fireEvent.click(
      screen.getByLabelText('I checked that the exact payment shown above was received.')
    )
    await act(async () => bridge.subscribeNativeCheckoutLock.mock.calls[0][0]())
    expect(screen.queryByText('QA Milk cake')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Unlock payment review' }))
    await screen.findByRole('heading', { name: 'Review the saved payment' })
    expect(
      screen.getByLabelText('I checked that the exact payment shown above was received.')
    ).not.toBeChecked()
    expect(
      screen.getByRole('button', { name: 'Confirm received payment & save receipt' })
    ).toBeDisabled()
  })
  it('rejects a delayed begin result after the native app locks, retaining recovery identity', async () => {
    let resolve!: (value: unknown) => void
    bridge.beginNativePaymentIntent.mockReturnValue(new Promise((r) => (resolve = r)))
    render(<NativeCounter {...props()} />)
    await review()
    fireEvent.click(screen.getByRole('button', { name: 'Save payment step before collection' }))
    const [intentId, request] = bridge.beginNativePaymentIntent.mock.calls[0]
    await act(async () => bridge.subscribeNativeCheckoutLock.mock.calls[0][0]())
    await act(async () => resolve({ ...intent, intentId, request }))
    expect(screen.queryByRole('heading', { name: 'Review the saved payment' })).toBeNull()
    expect(screen.queryByText('QA Milk cake')).toBeNull()
    expect(screen.getByText(intentId)).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Choose items' })).toBeNull()
  })
  it('rejects a delayed committed receipt after pagehide and reads it again only on recovery', async () => {
    let resolve!: (value: unknown) => void
    bridge.confirmNativePaymentIntent.mockReturnValue(new Promise((r) => (resolve = r)))
    render(<NativeCounter {...props()} />)
    await begin()
    const intentId = bridge.beginNativePaymentIntent.mock.calls[0][0]
    fireEvent.click(
      screen.getByLabelText('I checked that the exact payment shown above was received.')
    )
    fireEvent.click(screen.getByRole('button', { name: 'Confirm received payment & save receipt' }))
    await act(async () => window.dispatchEvent(new Event('pagehide')))
    const committed = {
      ...intent,
      intentId,
      state: 'committed',
      canConfirm: false,
      canCancel: false,
      receipt,
    }
    await act(async () => resolve(committed))
    expect(screen.queryByRole('heading', { name: receipt.documentNumber })).toBeNull()
    bridge.readNativePaymentIntent.mockResolvedValue(committed)
    fireEvent.click(screen.getByRole('button', { name: 'Check saved payment' }))
    await screen.findByRole('heading', { name: receipt.documentNumber })
    expect(bridge.confirmNativePaymentIntent).toHaveBeenCalledTimes(1)
  })
  it('fails closed when native lock monitoring cannot attach', async () => {
    bridge.subscribeNativeCheckoutLock.mockRejectedValue(new Error('unavailable'))
    const p = props()
    render(<NativeCounter {...p} />)
    await screen.findByRole('alert')
    expect(screen.queryByRole('heading', { name: 'Choose items' })).toBeNull()
    expect(p.onHoldChange).toHaveBeenLastCalledWith(true)
    expect(bridge.readNativeCheckout).not.toHaveBeenCalled()
  })
  it('keeps original recovery reachable after unlock returns a pending intent', async () => {
    bridge.beginNativePaymentIntent.mockRejectedValueOnce(new Error('native_storage_unavailable'))
    render(<NativeCounter {...props()} />)
    await review()
    fireEvent.click(screen.getByRole('button', { name: 'Save payment step before collection' }))
    await screen.findByRole('alert')
    const [intentId, request] = bridge.beginNativePaymentIntent.mock.calls[0]
    const pending = { ...intent, intentId, request }
    bridge.readNativeCheckout.mockResolvedValue({
      ...state,
      canIssue: false,
      pendingIntentId: intentId,
      unresolvedIntent: pending,
      reasonCode: 'payment_reconciliation_required',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock payment review' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Check saved payment' })).toBeEnabled()
    )
    expect(
      screen.queryByRole('button', { name: 'Confirm received payment & save receipt' })
    ).toBeNull()
    bridge.readNativePaymentIntent.mockResolvedValue(pending)
    fireEvent.click(screen.getByRole('button', { name: 'Check saved payment' }))
    await screen.findByRole('heading', { name: 'Review the saved payment' })
    fireEvent.click(
      screen.getByLabelText('I checked that the exact payment shown above was received.')
    )
    fireEvent.click(screen.getByRole('button', { name: 'Confirm received payment & save receipt' }))
    await screen.findByRole('heading', { name: receipt.documentNumber })
    expect(bridge.beginNativePaymentIntent).toHaveBeenCalledTimes(1)
    expect(bridge.confirmNativePaymentIntent).toHaveBeenCalledExactlyOnceWith(intentId)
  })
  it('permanently freezes the exact expired payment only after separate intent-bound consent', async () => {
    const saved = { ...intent, canConfirm: false, reasonCode: 'clock_expired' }
    const frozen = {
      ...saved,
      state: 'frozen_for_manager',
      canCancel: false,
      reasonCode: 'payment_frozen',
      managerReview: { freezeId: id(12), proofSha256: 'a'.repeat(64), status: 'saved_locally' },
    }
    bridge.readNativeCheckout.mockResolvedValue({
      ...state,
      canIssue: false,
      pendingIntentId: intent.intentId,
      unresolvedIntent: saved,
      reasonCode: 'payment_reconciliation_required',
    })
    bridge.freezeNativePaymentForManager.mockResolvedValue(frozen)
    const p = props()
    render(<NativeCounter {...p} />)
    await screen.findByRole('heading', { name: 'Review the saved payment' })
    fireEvent.click(screen.getByText('Payment needs manager review', { exact: true }))
    const button = screen.getByRole('button', { name: 'Permanently freeze payment' })
    expect(button).toBeDisabled()
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: /I confirm permanently freezing this exact saved payment/,
      })
    )
    fireEvent.click(button)
    await screen.findByRole('heading', { name: 'Payment frozen for manager review' })
    expect(bridge.freezeNativePaymentForManager).toHaveBeenCalledExactlyOnceWith(intent.intentId)
    expect(screen.getByText('Saved locally · not sent')).toBeVisible()
    expect(screen.getByText(id(12))).toBeVisible()
    expect(
      screen.queryByRole('button', { name: 'Confirm received payment & save receipt' })
    ).toBeNull()
    expect(screen.queryByText('No money was received', { exact: true })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Choose items' })).toBeNull()
    expect(p.onHoldChange).toHaveBeenLastCalledWith(true)
    expect(bridge.confirmNativePaymentIntent).not.toHaveBeenCalled()
    expect(bridge.cancelNativeUncollectedIntent).not.toHaveBeenCalled()
  })
  it('reads the original intent after a lost freeze response without repeating the mutation', async () => {
    const frozen = {
      ...intent,
      state: 'frozen_for_manager',
      canConfirm: false,
      canCancel: false,
      reasonCode: 'payment_frozen',
      managerReview: { freezeId: id(12), proofSha256: 'b'.repeat(64), status: 'saved_locally' },
    }
    bridge.readNativeCheckout.mockResolvedValue({
      ...state,
      canIssue: false,
      pendingIntentId: intent.intentId,
      unresolvedIntent: intent,
      reasonCode: 'payment_reconciliation_required',
    })
    bridge.freezeNativePaymentForManager.mockRejectedValue(new Error('native_storage_unavailable'))
    bridge.readNativePaymentIntent.mockResolvedValue(frozen)
    render(<NativeCounter {...props()} />)
    await screen.findByRole('heading', { name: 'Review the saved payment' })
    fireEvent.click(screen.getByText('Payment needs manager review', { exact: true }))
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirm permanently freezing/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Permanently freeze payment' }))
    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: 'Permanently freeze payment' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check saved payment' }))
    await screen.findByRole('heading', { name: 'Payment frozen for manager review' })
    expect(bridge.readNativePaymentIntent).toHaveBeenCalledExactlyOnceWith(intent.intentId)
    expect(bridge.freezeNativePaymentForManager).toHaveBeenCalledTimes(1)
  })
  it('hides frozen proof and previous receipt while locked and preserves global custody', async () => {
    const frozen = {
      ...intent,
      state: 'frozen_for_manager',
      canConfirm: false,
      canCancel: false,
      reasonCode: 'payment_frozen',
      managerReview: { freezeId: id(12), proofSha256: 'c'.repeat(64), status: 'saved_locally' },
    }
    bridge.readNativeCheckout.mockResolvedValue({
      ...state,
      canIssue: false,
      pendingIntentId: intent.intentId,
      unresolvedIntent: frozen,
      lastReceiptId: receipt.id,
      lastReceipt: receipt,
      reasonCode: 'payment_frozen',
    })
    const p = props()
    render(<NativeCounter {...p} />)
    await screen.findByRole('heading', { name: 'Payment frozen for manager review' })
    expect(screen.queryByRole('heading', { name: receipt.documentNumber })).toBeNull()
    const support = screen.getByText('Support details').closest('details')!
    expect(support.open).toBe(false)
    expect(screen.getByText('c'.repeat(64))).toBeInTheDocument()
    await act(async () => bridge.subscribeNativeCheckoutLock.mock.calls[0][0]())
    expect(screen.queryByText(id(12))).toBeNull()
    expect(screen.queryByText('c'.repeat(64))).toBeNull()
    expect(screen.queryByText('QA Milk cake')).toBeNull()
    expect(p.onHoldChange).toHaveBeenLastCalledWith(true)
  })
  it('discards a delayed freeze response after native lock and recovers only by original reference', async () => {
    let resolve!: (value: unknown) => void
    const frozen = {
      ...intent,
      state: 'frozen_for_manager',
      canConfirm: false,
      canCancel: false,
      reasonCode: 'payment_frozen',
      managerReview: { freezeId: id(12), proofSha256: 'd'.repeat(64), status: 'saved_locally' },
    }
    bridge.readNativeCheckout.mockResolvedValue({
      ...state,
      canIssue: false,
      pendingIntentId: intent.intentId,
      unresolvedIntent: intent,
      reasonCode: 'payment_reconciliation_required',
    })
    bridge.freezeNativePaymentForManager.mockReturnValue(new Promise((r) => (resolve = r)))
    render(<NativeCounter {...props()} />)
    await screen.findByRole('heading', { name: 'Review the saved payment' })
    fireEvent.click(screen.getByText('Payment needs manager review', { exact: true }))
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirm permanently freezing/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Permanently freeze payment' }))
    await act(async () => bridge.subscribeNativeCheckoutLock.mock.calls[0][0]())
    await act(async () => resolve(frozen))
    expect(screen.queryByText(id(12))).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Payment frozen for manager review' })).toBeNull()
    bridge.readNativePaymentIntent.mockResolvedValue(frozen)
    fireEvent.click(screen.getByRole('button', { name: 'Check saved payment' }))
    await screen.findByRole('heading', { name: 'Payment frozen for manager review' })
    expect(bridge.freezeNativePaymentForManager).toHaveBeenCalledTimes(1)
  })
  it('rejects frozen acknowledgement for a changed original request and keeps recovery held', async () => {
    bridge.readNativeCheckout.mockResolvedValue({
      ...state,
      canIssue: false,
      pendingIntentId: intent.intentId,
      unresolvedIntent: intent,
      reasonCode: 'payment_reconciliation_required',
    })
    bridge.freezeNativePaymentForManager.mockResolvedValue({
      ...intent,
      state: 'frozen_for_manager',
      canConfirm: false,
      canCancel: false,
      reasonCode: 'payment_frozen',
      request: { ...intent.request, serviceType: 'delivery' },
      managerReview: { freezeId: id(12), proofSha256: 'e'.repeat(64), status: 'saved_locally' },
    })
    const p = props()
    render(<NativeCounter {...p} />)
    await screen.findByRole('heading', { name: 'Review the saved payment' })
    fireEvent.click(screen.getByText('Payment needs manager review', { exact: true }))
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirm permanently freezing/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Permanently freeze payment' }))
    await screen.findByRole('alert')
    expect(screen.queryByRole('heading', { name: 'Payment frozen for manager review' })).toBeNull()
    expect(p.onHoldChange).toHaveBeenLastCalledWith(true)
  })
})

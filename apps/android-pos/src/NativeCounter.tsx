import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type NativeCheckoutState,
  type NativeCheckoutRequest,
  type NativeQuoteInput,
  type NativeQuote,
  type NativeIntent,
  type NativeReceipt,
  readNativeCheckout,
  quoteNativeBasket,
  beginNativePaymentIntent,
  readNativePaymentIntent,
  confirmNativePaymentIntent,
  cancelNativeUncollectedIntent,
  unlockNativeOffline,
  checkoutRequestKey,
  quoteInputKey,
  quantityToMilli,
  openingCashToFils,
  nativeCheckoutError,
  knownCheckoutReason,
  nativeOfflineErrorCode,
  subscribeNativeCheckoutLock,
} from './native'

const money = (fils: number) => `AED ${(fils / 100).toFixed(2)}`
const date = (value: string) =>
  new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Dubai',
  }).format(new Date(value))
const serviceNames = { dine_in: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' }
function Bill({ bill }: { bill: NativeQuote | NativeReceipt }) {
  return (
    <div className="native-bill">
      <ul className="native-bill-lines">
        {bill.lines.map((line) => (
          <li key={line.lineNumber}>
            <div>
              <strong>{line.name}</strong>
              <span>
                {line.quantityMilli / 1000}{' '}
                {line.unit === 'kg' ? 'kg' : line.unit === 'pack' ? 'pack(s)' : 'piece(s)'}
              </span>
            </div>
            <strong>{money(line.grossFils)}</strong>
          </li>
        ))}
      </ul>
      <dl className="native-totals">
        <div>
          <dt>Before VAT</dt>
          <dd>{money(bill.totals.netFils)}</dd>
        </div>
        <div>
          <dt>VAT</dt>
          <dd>{money(bill.totals.taxFils)}</dd>
        </div>
        <div className="native-grand-total">
          <dt>Total</dt>
          <dd>{money(bill.totals.grossFils)}</dd>
        </div>
        {bill.payments.map((p) => (
          <div key={p.method}>
            <dt>{p.method === 'cash' ? 'Cash applied' : 'Externally recorded card'}</dt>
            <dd>{money(p.amountFils)}</dd>
          </div>
        ))}
        <div>
          <dt>Cash tendered</dt>
          <dd>{money(bill.cashTenderedFils)}</dd>
        </div>
        <div>
          <dt>Change</dt>
          <dd>{money(bill.changeFils)}</dd>
        </div>
      </dl>
    </div>
  )
}
export function NativeReceiptView({ receipt }: { receipt: NativeReceipt }) {
  return (
    <section className="native-receipt" aria-labelledby="native-receipt-heading">
      <p className="eyebrow">Saved bill</p>
      <h2 id="native-receipt-heading">{receipt.documentNumber}</h2>
      <p className="access-note">
        {receipt.syncState === 'pending'
          ? 'Saved on this device · awaiting sync'
          : 'Server acknowledged this receipt'}
        . Do not collect this payment again.
      </p>
      <div className="receipt-merchant">
        <strong>{receipt.merchant.legalName}</strong>
        <p>
          {receipt.merchant.branchName}
          <br />
          {receipt.merchant.address}
          <br />
          {receipt.merchant.phone}
          <br />
          VAT TRN {receipt.merchant.trn}
        </p>
      </div>
      <p>
        {date(receipt.issuedAt)} Dubai time · {serviceNames[receipt.serviceType]}
      </p>
      {receipt.customer && (
        <p>
          <strong>{receipt.customer.name}</strong>
          <br />
          {receipt.customer.address}
          {receipt.customer.trn && (
            <>
              <br />
              Buyer TRN {receipt.customer.trn}
            </>
          )}
        </p>
      )}
      <Bill bill={receipt} />
      <p className="help">
        This offline bill has not been sent to the cloud kitchen. Tell the kitchen directly.
        Printing is not available on this screen.
      </p>
    </section>
  )
}

type Props = {
  available: boolean
  ready: boolean
  revision: number
  operationLock: { current: boolean }
  onBusyChange: (busy: boolean) => void
  onHoldChange: (hold: boolean) => void
  onRecordsChanged: () => void
  onGoToDevice: () => void
}
export default function NativeCounter({
  available,
  ready,
  revision,
  operationLock,
  onBusyChange,
  onHoldChange,
  onRecordsChanged,
  onGoToDevice,
}: Props) {
  const [listening, setListening] = useState(false)
  const epoch = useRef(0)
  const appliedScope = useRef<string | null>(null)
  const [state, setState] = useState<NativeCheckoutState | null>(null)
  const [fresh, setFresh] = useState(false)
  const [checkedRevision, setCheckedRevision] = useState(-1)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [intent, setIntent] = useState<NativeIntent | null>(null)
  const [uncertain, setUncertain] = useState<{
    intentId: string
    request: NativeCheckoutRequest
  } | null>(null)
  const [retrySameBegin, setRetrySameBegin] = useState(false)
  const beginUncertain = useRef(false)
  const [quote, setQuote] = useState<NativeQuote | null>(null)
  const [quoteKey, setQuoteKey] = useState<string | null>(null)
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [service, setService] = useState<NativeQuoteInput['serviceType']>('takeaway')
  const [tender, setTender] = useState<NativeQuoteInput['tenderMode']>('cash')
  const [cash, setCash] = useState('')
  const [card, setCard] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [customerAddress, setCustomerAddress] = useState('')
  const [customerTrn, setCustomerTrn] = useState('')
  const [receivedConsent, setReceivedConsent] = useState<string | null>(null)
  const [noMoneyConsent, setNoMoneyConsent] = useState<string | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [search, setSearch] = useState('')
  const [showLast, setShowLast] = useState(true)
  const mounted = useRef(false)
  const generation = useRef(0)
  const active = useRef(false)
  const currentRevision = useRef(revision)
  currentRevision.current = revision
  const context =
    listening && ready && fresh && checkedRevision === revision ? state?.context : null
  const pendingId = uncertain?.intentId ?? state?.pendingIntentId ?? null
  const pending = intent?.state === 'payment_confirmation_required' ? intent : null
  const hold =
    available &&
    (!listening ||
      !fresh ||
      checkedRevision !== revision ||
      !!pendingId ||
      !!pending ||
      !!uncertain)
  useEffect(() => {
    onHoldChange(hold)
  }, [hold, onHoldChange])
  const start = (label: string) => {
    if (!available || !ready || !listening || operationLock.current || active.current) return false
    operationLock.current = true
    active.current = true
    setBusy(label)
    onBusyChange(true)
    setError('')
    setNotice('')
    return true
  }
  const finish = () => {
    operationLock.current = false
    active.current = false
    if (mounted.current) {
      setBusy(null)
      onBusyChange(false)
    }
  }
  const clearDraft = useCallback(() => {
    generation.current++
    setQuote(null)
    setQuoteKey(null)
    setQuantities({})
    setCash('')
    setCard('')
    setCustomerName('')
    setCustomerAddress('')
    setCustomerTrn('')
    setReceivedConsent(null)
    setNoMoneyConsent(null)
    setCancelReason('')
  }, [])
  const applyState = useCallback(
    (next: NativeCheckoutState, version: number) => {
      if (!mounted.current || version !== currentRevision.current) return
      const scope = next.context
        ? `${next.context.actorId}:${next.context.authorityId}:${next.context.snapshotId}`
        : null
      if (appliedScope.current !== scope) {
        clearDraft()
        appliedScope.current = scope
        const p = next.context?.permissions
        setTender(p?.cash ? 'cash' : p?.recordedCard ? 'card' : 'mixed')
      }
      setReceivedConsent(null)
      setNoMoneyConsent(null)
      setCancelReason('')
      setState(next)
      setFresh(true)
      setCheckedRevision(version)
      setIntent(next.unresolvedIntent)
    },
    [clearDraft]
  )
  const check = useCallback(async () => {
    if (!available || !ready || !listening || operationLock.current || active.current) return
    operationLock.current = true
    active.current = true
    setBusy('Checking saved payments…')
    onBusyChange(true)
    setFresh(false)
    setError('')
    const version = revision
    const operationEpoch = epoch.current
    try {
      const next = await readNativeCheckout()
      if (operationEpoch === epoch.current) applyState(next, version)
    } catch (failure) {
      if (mounted.current) setError(nativeCheckoutError(failure))
    } finally {
      operationLock.current = false
      active.current = false
      if (mounted.current) {
        setBusy(null)
        onBusyChange(false)
      }
    }
  }, [available, ready, listening, revision, operationLock, onBusyChange, applyState])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!available) return
    let disposed = false
    let remove: (() => Promise<void>) | undefined
    const invalidate = () => {
      epoch.current++
      generation.current++
      setFresh(false)
      setIntent(null)
      clearDraft()
      setRetrySameBegin(false)
      setState((previous) =>
        previous
          ? {
              ...previous,
              canIssue: false,
              reasonCode: 'pin_unlock_required',
              context: null,
              unresolvedIntent: null,
              lastReceipt: null,
            }
          : null
      )
      onHoldChange(true)
      setNotice('Payment details are locked. Unlock payment review before continuing.')
      setError('')
    }
    const visibility = () => {
      if (document.visibilityState === 'hidden') invalidate()
    }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', invalidate)
    void subscribeNativeCheckoutLock(invalidate)
      .then((handle) => {
        if (disposed) void handle.remove()
        else {
          remove = () => handle.remove()
          setListening(true)
        }
      })
      .catch(() => {
        if (!disposed) {
          invalidate()
          setListening(false)
          setError(
            'Payment lock monitoring is unavailable. Keep this app’s data and contact your manager. New collection is paused.'
          )
        }
      })
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', invalidate)
      if (remove) void remove()
    }
  }, [available, clearDraft, onHoldChange])
  useEffect(() => {
    if (ready && listening) void check()
  }, [check, ready, listening])
  // Scope changes invalidate old details immediately, before any delayed native read resolves.
  const visibleIntent =
    !uncertain && listening && ready && fresh && checkedRevision === revision ? pending : null
  const receipt =
    !uncertain && listening && ready && fresh && checkedRevision === revision
      ? (intent?.receipt ?? (showLast ? state?.lastReceipt : null))
      : null
  function dirty(action: () => void) {
    generation.current++
    setQuote(null)
    setQuoteKey(null)
    setReceivedConsent(null)
    action()
  }
  function input(): NativeQuoteInput | null {
    if (!context) return null
    const lines = []
    for (const product of context.products) {
      const value = quantities[product.id]
      if (!value) continue
      const milli = quantityToMilli(value, product.unit)
      if (milli === null) return null
      lines.push({ productId: product.id, quantityMilli: milli })
    }
    if (!lines.length) return null
    const buyerStarted = !!(customerName.trim() || customerAddress.trim() || customerTrn.trim())
    if (
      buyerStarted &&
      (!customerName.trim() ||
        !customerAddress.trim() ||
        (customerTrn.trim() && !/^\d{15}$/.test(customerTrn.trim())))
    )
      return null
    const cashValue = cash.trim() ? openingCashToFils(cash) : null
    const cardValue = card.trim() ? openingCashToFils(card) : null
    if (
      (cash.trim() && cashValue === null) ||
      (card.trim() && cardValue === null) ||
      (tender === 'mixed' && (!cardValue || cardValue < 1))
    )
      return null
    return {
      authorityId: context.authorityId,
      serviceType: service,
      customer: buyerStarted
        ? {
            name: customerName.trim(),
            address: customerAddress.trim(),
            trn: customerTrn.trim() || null,
          }
        : null,
      lines,
      tenderMode: tender,
      cashTenderedFils: tender === 'card' ? 0 : cashValue,
      recordedCardFils: tender === 'cash' ? 0 : tender === 'card' ? null : cardValue,
    }
  }
  const currentInput = input()
  const currentKey = currentInput ? quoteInputKey(currentInput) : null
  const validQuote = quote && quoteKey === currentKey ? quote : null
  const editsBlocked = !!busy || !ready || hold || !!intent?.receipt
  const canBegin = !!(
    state?.canIssue &&
    knownCheckoutReason(state.reasonCode) &&
    state.reasonCode === null &&
    validQuote &&
    (!validQuote.requiresBuyerDetails || validQuote.request.customer !== null) &&
    !editsBlocked
  )
  async function review() {
    const request = input()
    if (!request || editsBlocked || !start('Calculating the bill on this device…')) return
    const ticket = ++generation.current
    const version = revision
    const operationEpoch = epoch.current
    try {
      const next = await quoteNativeBasket(request)
      if (
        mounted.current &&
        operationEpoch === epoch.current &&
        ticket === generation.current &&
        version === currentRevision.current
      ) {
        setQuote(next)
        setQuoteKey(quoteInputKey(request))
        setShowLast(false)
      }
    } catch (failure) {
      if (mounted.current) setError(nativeCheckoutError(failure))
    } finally {
      finish()
    }
  }
  function acceptIntent(
    next: NativeIntent,
    original: { intentId: string; request: NativeCheckoutRequest }
  ) {
    if (
      next.intentId !== original.intentId ||
      checkoutRequestKey(next.request) !== checkoutRequestKey(original.request)
    )
      throw new Error('invalid_native_response')
    setIntent(next)
    setUncertain(null)
    setRetrySameBegin(false)
    beginUncertain.current = false
    setReceivedConsent(null)
    setNoMoneyConsent(null)
    setCancelReason('')
    setFresh(true)
    setCheckedRevision(revision)
    setState((previous) =>
      previous
        ? {
            ...previous,
            canIssue: false,
            pendingIntentId: next.state === 'payment_confirmation_required' ? next.intentId : null,
            unresolvedIntent: next.state === 'payment_confirmation_required' ? next : null,
            lastReceiptId: next.receipt?.id ?? previous.lastReceiptId,
            lastReceipt: next.receipt ?? previous.lastReceipt,
          }
        : previous
    )
    if (next.state === 'committed') {
      clearDraft()
      setShowLast(true)
      setNotice('Receipt saved. Do not collect this payment again.')
      onRecordsChanged()
    }
    if (next.state === 'cancelled') {
      clearDraft()
      setNotice(
        'The saved payment was cancelled with no money received. Check counter status before starting another sale.'
      )
      onRecordsChanged()
    }
  }
  async function begin() {
    if (!canBegin || !validQuote || !start('Saving payment before collection…')) return
    const operationEpoch = epoch.current
    const operationRevision = revision
    const original = { intentId: crypto.randomUUID(), request: validQuote.request }
    setUncertain(original)
    beginUncertain.current = true
    onHoldChange(true)
    try {
      const next = await beginNativePaymentIntent(original.intentId, original.request)
      if (
        mounted.current &&
        operationEpoch === epoch.current &&
        operationRevision === currentRevision.current
      )
        acceptIntent(next, original)
    } catch (failure) {
      if (mounted.current) {
        setFresh(false)
        setError(
          `${nativeCheckoutError(failure)} Check this saved payment before doing anything else. Do not collect payment until its saved details are confirmed.`
        )
      }
    } finally {
      finish()
    }
  }
  async function recover() {
    const original = uncertain
    if (!start('Checking the original saved payment…')) return
    const operationEpoch = epoch.current
    const operationRevision = revision
    try {
      if (original) {
        const next = await readNativePaymentIntent(original.intentId)
        if (
          mounted.current &&
          operationEpoch === epoch.current &&
          operationRevision === currentRevision.current
        )
          acceptIntent(next, original)
      } else {
        const next = await readNativeCheckout()
        if (operationEpoch === epoch.current) applyState(next, operationRevision)
      }
    } catch (failure) {
      if (mounted.current) {
        setFresh(false)
        setRetrySameBegin(
          beginUncertain.current && nativeOfflineErrorCode(failure) === 'intent_missing'
        )
        setError(nativeCheckoutError(failure))
      }
    } finally {
      finish()
    }
  }
  async function retryBegin() {
    const original = uncertain
    if (
      !original ||
      !retrySameBegin ||
      !beginUncertain.current ||
      !start('Retrying the same saved payment step…')
    )
      return
    setRetrySameBegin(false)
    const operationEpoch = epoch.current
    const operationRevision = revision
    try {
      const next = await beginNativePaymentIntent(original.intentId, original.request)
      if (
        mounted.current &&
        operationEpoch === epoch.current &&
        operationRevision === currentRevision.current
      )
        acceptIntent(next, original)
    } catch (failure) {
      if (mounted.current) {
        setFresh(false)
        setError(nativeCheckoutError(failure))
      }
    } finally {
      finish()
    }
  }
  async function resolve(kind: 'confirm' | 'cancel') {
    if (!visibleIntent || !knownCheckoutReason(visibleIntent.reasonCode) || !!uncertain) return
    const original = { intentId: visibleIntent.intentId, request: visibleIntent.request }
    const identity = `${original.intentId}:${checkoutRequestKey(original.request)}`
    if (kind === 'confirm' && (!visibleIntent.canConfirm || receivedConsent !== identity)) return
    if (
      kind === 'cancel' &&
      (!visibleIntent.canCancel || noMoneyConsent !== identity || !cancelReason.trim())
    )
      return
    if (
      !start(
        kind === 'confirm'
          ? 'Saving the received payment and receipt…'
          : 'Cancelling the uncollected payment…'
      )
    )
      return
    const operationEpoch = epoch.current
    const operationRevision = revision
    setUncertain(original)
    onHoldChange(true)
    try {
      const next = await (kind === 'confirm'
        ? confirmNativePaymentIntent(original.intentId)
        : cancelNativeUncollectedIntent(original.intentId, cancelReason.trim()))
      if (
        mounted.current &&
        operationEpoch === epoch.current &&
        operationRevision === currentRevision.current
      )
        acceptIntent(next, original)
    } catch (failure) {
      if (mounted.current) {
        setFresh(false)
        setError(`${nativeCheckoutError(failure)} Check the original payment; do not charge again.`)
      }
    } finally {
      finish()
    }
  }
  async function unlock() {
    if (!start('Complete payment review unlock in the Android PIN dialog.')) return
    setFresh(false)
    const operationEpoch = epoch.current
    const operationRevision = revision
    try {
      await unlockNativeOffline()
      const next = await readNativeCheckout()
      if (operationEpoch === epoch.current) applyState(next, operationRevision)
    } catch (failure) {
      if (mounted.current) setError(nativeCheckoutError(failure))
    } finally {
      finish()
    }
  }
  const intentKey = visibleIntent
    ? `${visibleIntent.intentId}:${checkoutRequestKey(visibleIntent.request)}`
    : null
  return (
    <section className="native-counter" aria-labelledby="native-counter-heading">
      <div className="counter-heading">
        <div>
          <p className="eyebrow">Local counter</p>
          <h2 id="native-counter-heading">{context?.branchName ?? 'Your Android counter'}</h2>
        </div>
        <button
          className="secondary"
          disabled={!available || !ready || !!busy}
          onClick={() => void check()}
        >
          Check counter status
        </button>
      </div>
      {!available ? (
        <p className="access-note">
          Open the installed Android app to access its saved menu, payments and receipts.
        </p>
      ) : (
        <>
          {busy && (
            <p className="access-note" role="status">
              {busy}
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="access-note" role="status">
              {notice}
            </p>
          )}
          {hold && (
            <div className="payment-attention">
              <h3>{pendingId ? 'Saved payment needs checking' : 'Check saved payments first'}</h3>
              <p>
                {pendingId
                  ? 'Keep this original payment. Check whether money was already received; never ask the customer to pay twice.'
                  : 'New collection and setup changes remain paused until this device’s saved payment status is checked.'}
              </p>
              {pendingId && (
                <p className="help">
                  Payment reference <span className="reference">{pendingId}</span>
                </p>
              )}
              {!visibleIntent && (
                <div className="reconciliation-actions">
                  <button
                    className="secondary"
                    disabled={!!busy || !ready}
                    onClick={() => void recover()}
                  >
                    Check saved payment
                  </button>
                  {retrySameBegin && (
                    <button
                      className="secondary"
                      disabled={!!busy || !ready || !listening}
                      onClick={() => void retryBegin()}
                    >
                      Retry saving this same payment step
                    </button>
                  )}
                  <button
                    className="secondary"
                    disabled={!!busy || !ready}
                    onClick={() => void unlock()}
                  >
                    Unlock payment review
                  </button>
                  <button className="secondary" disabled={!!busy} onClick={onGoToDevice}>
                    Go to account access
                  </button>
                </div>
              )}
            </div>
          )}
          {visibleIntent && (
            <section className="payment-review" aria-labelledby="payment-review-heading">
              <h3 id="payment-review-heading">Review the saved payment</h3>
              <p>
                {serviceNames[visibleIntent.request.serviceType]} · Saved{' '}
                {date(visibleIntent.createdAt)} Dubai time
              </p>
              <Bill bill={visibleIntent.quote} />
              <p className="access-note">
                The payment step is saved on this device. Cash is handled at the counter; card
                payment happens on your separate card terminal. This app does not charge a card. If
                this is a recovered payment, check the cash drawer or terminal result first.
              </p>
              {visibleIntent.reasonCode && (
                <p className="error">{nativeCheckoutError(new Error(visibleIntent.reasonCode))}</p>
              )}
              <label className="cash-confirm">
                <input
                  type="checkbox"
                  checked={receivedConsent === intentKey}
                  disabled={
                    !!busy ||
                    !visibleIntent.canConfirm ||
                    !knownCheckoutReason(visibleIntent.reasonCode)
                  }
                  onChange={(e) => setReceivedConsent(e.target.checked ? intentKey : null)}
                />
                I checked that the exact payment shown above was received.
              </label>
              <button
                className="primary"
                disabled={
                  !!busy ||
                  !visibleIntent.canConfirm ||
                  !knownCheckoutReason(visibleIntent.reasonCode) ||
                  receivedConsent !== intentKey
                }
                onClick={() => void resolve('confirm')}
              >
                Confirm received payment &amp; save receipt
              </button>
              <details className="no-money">
                <summary>No money was received</summary>
                <p>
                  Only cancel if no cash was taken and no card transaction succeeded. If money was
                  received but the receipt is blocked, keep this payment and contact your manager.
                </p>
                <label>
                  Reason for no-money cancellation
                  <textarea
                    maxLength={240}
                    value={cancelReason}
                    disabled={!!busy}
                    onChange={(e) => setCancelReason(e.target.value)}
                  />
                </label>
                <label className="cash-confirm">
                  <input
                    type="checkbox"
                    checked={noMoneyConsent === intentKey}
                    disabled={!!busy || !visibleIntent.canCancel}
                    onChange={(e) => setNoMoneyConsent(e.target.checked ? intentKey : null)}
                  />
                  I checked that no money was received.
                </label>
                <button
                  className="secondary"
                  disabled={
                    !!busy ||
                    !visibleIntent.canCancel ||
                    !knownCheckoutReason(visibleIntent.reasonCode) ||
                    noMoneyConsent !== intentKey ||
                    !cancelReason.trim()
                  }
                  onClick={() => void resolve('cancel')}
                >
                  Cancel uncollected payment
                </button>
              </details>
              {!visibleIntent.canCancel && (
                <button
                  className="secondary"
                  disabled={!!busy || !ready}
                  onClick={() => void unlock()}
                >
                  Unlock payment review
                </button>
              )}
            </section>
          )}
          {receipt && (
            <>
              <NativeReceiptView receipt={receipt} />
              <button
                className="secondary"
                disabled={!!busy || hold}
                onClick={() => {
                  setIntent(null)
                  setShowLast(false)
                  clearDraft()
                  void check()
                }}
              >
                Start a new basket
              </button>
            </>
          )}
          {!hold && !visibleIntent && !receipt && context && (
            <>
              {!state?.canIssue && (
                <p className="access-note">
                  New sales paused. You can review the saved menu and a native bill calculation. Do
                  not collect money from this preview.
                </p>
              )}
              {state?.reasonCode && (
                <p className="help">{nativeCheckoutError(new Error(state.reasonCode))}</p>
              )}
              <p className="help">
                Menu saved {date(context.snapshotCreatedAt)} Dubai time. Prices below are from the
                saved menu; the reviewed bill is calculated by Android. Offers, refunds and shared
                online tabs are unavailable here.
              </p>
              <div className="counter-grid">
                <section className="native-menu">
                  <h3>Choose items</h3>
                  <label>
                    Find a menu item
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      disabled={editsBlocked}
                      type="search"
                    />
                  </label>
                  <div className="native-products">
                    {context.products
                      .filter((p) =>
                        `${p.name} ${p.category}`.toLowerCase().includes(search.toLowerCase())
                      )
                      .map((p) => (
                        <div className="native-product" key={p.id}>
                          <div>
                            <strong>{p.name}</strong>
                            <span>
                              {p.category} · {money(p.unitPriceFils)} / {p.unit}
                            </span>
                          </div>
                          <label>
                            <span>{p.unit === 'kg' ? 'Weight (kg)' : 'Quantity'}</span>
                            <input
                              aria-label={`${p.name} ${p.unit === 'kg' ? 'weight in kg' : 'quantity'}`}
                              inputMode={p.unit === 'kg' ? 'decimal' : 'numeric'}
                              placeholder="0"
                              value={quantities[p.id] ?? ''}
                              disabled={editsBlocked}
                              onChange={(e) =>
                                dirty(() =>
                                  setQuantities({ ...quantities, [p.id]: e.target.value })
                                )
                              }
                            />
                          </label>
                        </div>
                      ))}
                  </div>
                </section>
                <section className="native-basket">
                  <h3>Review this basket</h3>
                  <label>
                    Order type
                    <select
                      value={service}
                      disabled={editsBlocked}
                      onChange={(e) =>
                        dirty(() => setService(e.target.value as NativeQuoteInput['serviceType']))
                      }
                    >
                      {Object.entries(serviceNames).map(([key, label]) => (
                        <option value={key} key={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <details className="buyer-details">
                    <summary>Customer details</summary>
                    <p className="help">
                      Enter name and address together. Android will require these when the bill
                      needs them.
                    </p>
                    <label>
                      Customer name
                      <input
                        value={customerName}
                        maxLength={200}
                        disabled={editsBlocked}
                        onChange={(e) => dirty(() => setCustomerName(e.target.value))}
                      />
                    </label>
                    <label>
                      Customer address
                      <textarea
                        value={customerAddress}
                        maxLength={400}
                        disabled={editsBlocked}
                        onChange={(e) => dirty(() => setCustomerAddress(e.target.value))}
                      />
                    </label>
                    <label>
                      Customer TRN (optional)
                      <input
                        value={customerTrn}
                        maxLength={15}
                        inputMode="numeric"
                        disabled={editsBlocked}
                        onChange={(e) => dirty(() => setCustomerTrn(e.target.value))}
                      />
                    </label>
                  </details>
                  <label>
                    Payment method
                    <select
                      value={tender}
                      disabled={editsBlocked}
                      onChange={(e) =>
                        dirty(() => {
                          setTender(e.target.value as NativeQuoteInput['tenderMode'])
                          setCash('')
                          setCard('')
                        })
                      }
                    >
                      {context.permissions.cash && <option value="cash">Cash</option>}
                      {context.permissions.recordedCard && (
                        <option value="card">External card terminal</option>
                      )}
                      {context.permissions.mixedTender && (
                        <option value="mixed">Cash + external card</option>
                      )}
                    </select>
                  </label>
                  {tender !== 'card' && (
                    <label>
                      Cash tendered (AED)
                      <input
                        inputMode="decimal"
                        value={cash}
                        placeholder="Leave blank for exact cash due"
                        disabled={editsBlocked}
                        onChange={(e) => dirty(() => setCash(e.target.value))}
                      />
                    </label>
                  )}
                  {tender === 'mixed' && (
                    <label>
                      Card amount (AED)
                      <input
                        inputMode="decimal"
                        value={card}
                        disabled={editsBlocked}
                        onChange={(e) => dirty(() => setCard(e.target.value))}
                      />
                    </label>
                  )}
                  <p className="help">
                    Save the payment step before taking cash or using the card terminal. Once saved,
                    amounts cannot be edited.
                  </p>
                  <button
                    className="secondary"
                    disabled={editsBlocked || !currentInput}
                    onClick={() => void review()}
                  >
                    Review bill
                  </button>
                  {validQuote && (
                    <>
                      <Bill bill={validQuote} />
                      {validQuote.requiresBuyerDetails && !validQuote.request.customer && (
                        <p className="error">
                          Add the customer’s name and address, then review this bill again.
                        </p>
                      )}
                      <button className="primary" disabled={!canBegin} onClick={() => void begin()}>
                        Save payment step before collection
                      </button>
                    </>
                  )}
                </section>
              </div>
            </>
          )}
          {!hold && !context && !receipt && (
            <p className="access-note">
              Sign in and prepare this counter from This device to access the saved menu. Sales may
              still be paused after preparation.
            </p>
          )}
          {!receipt && state?.lastReceiptId && !state.lastReceipt && (
            <div>
              <p className="access-note">
                A receipt is saved on this device. Sign in with its original staff account and
                unlock payment review to see the bill details.
              </p>
              <button
                className="secondary"
                disabled={!!busy || !ready}
                onClick={() => void unlock()}
              >
                Unlock saved receipt
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}

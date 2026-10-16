'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { formatFils, parseMoney } from '@/lib/pos/money'
import { catalogueLineTotals } from '@/lib/pos/server/contracts'
import {
  liveBootstrapSchema,
  liveOrderSchema,
  liveCommandSchema,
  type LiveBootstrap,
  type LiveCommand,
  type LiveOrder,
} from '@/lib/pos/server/live-contracts'
import { fiscalDocumentSchema, type FiscalDocument } from '@/lib/pos/server/documents'
import {
  acknowledgePendingRequest,
  readPendingRequest,
  savePendingRequest,
  type PendingOnlineRequest,
} from '@/lib/pos/online-journal'
import FiscalReceipt from './FiscalReceipt'
import CatalogueManager from './CatalogueManager'
import BranchReports from './reports/BranchReports'
import OfferManager from './offers/OfferManager'
import OfferPicker from './offers/OfferPicker'
import StaffManager from './staff/StaffManager'
import AccountSettings from './staff/AccountSettings'
import PendingAccessRecovery from './staff/PendingAccessRecovery'
import type { OfferSelection, EligibleOfferQuote } from '@/lib/pos/server/offers'
import { invoiceMatchesSale } from '@/lib/pos/server/sale-ack'

type Product = LiveBootstrap['catalogue'][number]
type BasketLine = { product: Product; quantityMilli: number }
type View =
  | 'sell'
  | 'receipts'
  | 'shift'
  | 'branch'
  | 'menu'
  | 'offers'
  | 'reports'
  | 'staff'
  | 'account'
class ApiError extends Error {
  constructor(
    public status: number,
    public code: string
  ) {
    super(code)
  }
}
const currency = (value: number) => `AED ${formatFils(value)}`
const humanError = (error: unknown) => {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_credentials')
      return 'The email or password is incorrect. Please check and try again.'
    if (error.status === 401)
      return 'Sign in again to continue. Any pending sale is kept on this device.'
    if (error.status === 429)
      return 'Too many attempts. Please wait a few minutes before trying again.'
    if (error.code.includes('PRICE') || error.code.includes('PROFILE'))
      return 'The menu or business details changed. This request needs review before you take another payment.'
    if (error.code.includes('OFFER'))
      return 'This offer could not be confirmed. Resolve the saved request, reconcile any payment, then check offers again.'
    if (error.status === 403) return 'This account or device is not authorised for that action.'
    if (error.status === 503) return 'The counter service is not ready. Please retry shortly.'
    return 'The request could not be confirmed. Review the pending request before taking another payment.'
  }
  if (error instanceof Error && error.name === 'ZodError')
    return 'Check the order quantities, payment amounts and required details before continuing.'
  return error instanceof Error ? error.message : 'The connection failed. Please try again.'
}
async function api(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    })
  } catch {
    throw new Error(
      'No server confirmation received. Check your connection and retry the saved request.'
    )
  }
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok)
    throw new ApiError(
      response.status,
      data && typeof data === 'object' && 'code' in data ? String(data.code) : 'request_failed'
    )
  return data
}

export default function LiveCounter() {
  const [boot, setBoot] = useState<LiveBootstrap | null>(null)
  const [needsLogin, setNeedsLogin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const actorScope = useRef('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [online, setOnline] = useState(true)
  const [pending, setPending] = useState<PendingOnlineRequest | null>(null)
  const [branchId, setBranchId] = useState('')
  const [view, setView] = useState<View>('sell')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')
  const [basket, setBasket] = useState<BasketLine[]>([])
  const [serviceType, setServiceType] = useState<LiveOrder['serviceType']>('takeaway')
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'card' | 'split'>('cash')
  const [cashInput, setCashInput] = useState('')
  const [cardInput, setCardInput] = useState('')
  const [chosenOffer, setChosenOffer] = useState<{
    scope: string
    selection: OfferSelection
    quote: EligibleOfferQuote
  } | null>(null)
  const [buyerName, setBuyerName] = useState('')
  const [buyerAddress, setBuyerAddress] = useState('')
  const [buyerTrn, setBuyerTrn] = useState('')
  const [documents, setDocuments] = useState<FiscalDocument[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [selected, setSelected] = useState<FiscalDocument | null>(null)
  const [refundReason, setRefundReason] = useState('')
  const [refundConfirmed, setRefundConfirmed] = useState(false)
  const orderRef = useRef<HTMLElement>(null)
  const branch = boot?.branches.find((item) => item.id === branchId)
  const shift = boot?.shifts.find(
    (item) => item.deviceId === boot.device?.id && item.openedBy === boot.userId
  )
  const otherShift = boot?.shifts.find(
    (item) => item.deviceId === boot.device?.id && item.openedBy !== boot.userId
  )
  const manager = branch?.role === 'manager' || branch?.role === 'owner'
  const selectedCredited =
    selected?.kind === 'tax_invoice' &&
    documents.some((item) => item.kind === 'tax_credit_note' && item.orderId === selected.orderId)
  const products = boot?.catalogue.filter((item) => item.branchId === branchId) ?? []
  const visibleProducts = products.filter(
    (item) =>
      (category === 'All' || item.category === category) &&
      item.name.toLowerCase().includes(search.toLowerCase().trim())
  )
  const categories = Array.from(new Set(products.map((item) => item.category)))
  const beforeDiscount = basket.reduce(
    (sum, line) =>
      sum +
      catalogueLineTotals(line.product.unitPriceFils, line.quantityMilli, line.product.taxRateBps)
        .grossFils,
    0
  )
  const originalTax = basket.reduce(
    (sum, line) =>
      sum +
      catalogueLineTotals(line.product.unitPriceFils, line.quantityMilli, line.product.taxRateBps)
        .taxFils,
    0
  )
  const offerLines = useMemo(
    () =>
      basket.map(({ product, quantityMilli }) => ({
        productId: product.id,
        quantityMilli,
        expectedUnitPriceFils: product.unitPriceFils,
        expectedTaxRateBps: product.taxRateBps,
        expectedRevision: product.revision,
      })),
    [basket]
  )
  const offerScope = JSON.stringify({ branchId, serviceType, lines: offerLines })
  const activeOffer = chosenOffer?.scope === offerScope ? chosenOffer : null
  const total = activeOffer?.quote.grossFils ?? beforeDiscount
  const tax = activeOffer?.quote.taxFils ?? originalTax
  const chooseOffer = useCallback(
    (selection: OfferSelection | null, quote: EligibleOfferQuote | null) => {
      setChosenOffer(selection && quote ? { scope: offerScope, selection, quote } : null)
      setCashInput('')
      setCardInput('')
    },
    [offerScope]
  )
  const mayWrite = !!(
    boot?.capabilities.onlineSales &&
    branch?.canSell &&
    online &&
    boot.device &&
    !busy &&
    !pending &&
    branch?.profile
  )

  const refresh = useCallback(async () => {
    const next = liveBootstrapSchema.parse(await api('/api/pos/bootstrap'))
    const journal = await readPendingRequest(next.userId)
    const scope = `${next.userId}:${next.device?.id ?? ''}:${next.device?.branchId ?? ''}`
    if (actorScope.current !== scope) {
      setDocuments([])
      setNextCursor(null)
      setSelected(null)
      setBasket([])
      setChosenOffer(null)
      setCashInput('')
      setCardInput('')
      setBuyerName('')
      setBuyerAddress('')
      setBuyerTrn('')
      setRefundReason('')
      setRefundConfirmed(false)
      setSearch('')
      setCategory('All')
      setView('sell')
      setServiceType('takeaway')
      setPaymentMethod('cash')
      setNotice('')
      actorScope.current = scope
    }
    setBoot(next)
    setNeedsLogin(false)
    setPending(journal)
    setBranchId(
      (current) =>
        next.device?.branchId ??
        (next.branches.some((item) => item.id === current) ? current : (next.branches[0]?.id ?? ''))
    )
    return next
  }, [])
  const loadDocuments = useCallback(async (id: string, cursor?: string) => {
    const scope = actorScope.current
    const data = await api(
      `/api/pos/receipts?branchId=${encodeURIComponent(id)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    )
    if (scope !== actorScope.current) return
    if (!data || typeof data !== 'object' || !('receipts' in data) || !Array.isArray(data.receipts))
      throw new Error('Could not verify the receipt list.')
    const rows = data.receipts.map((value) => fiscalDocumentSchema.parse(value))
    setDocuments((current) =>
      cursor
        ? [...current, ...rows.filter((row) => !current.some((item) => item.id === row.id))]
        : rows
    )
    setNextCursor(
      'nextCursor' in data && typeof data.nextCursor === 'string' ? data.nextCursor : null
    )
  }, [])
  useEffect(() => {
    refresh()
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) setNeedsLogin(true)
        else setError(humanError(err))
      })
      .finally(() => setLoading(false))
    const connection = () => setOnline(navigator.onLine)
    connection()
    window.addEventListener('online', connection)
    window.addEventListener('offline', connection)
    return () => {
      window.removeEventListener('online', connection)
      window.removeEventListener('offline', connection)
    }
  }, [refresh])
  useEffect(() => {
    if (view === 'receipts' && branchId && !needsLogin)
      loadDocuments(branchId).catch((err) => setError(humanError(err)))
  }, [view, branchId, needsLogin, loadDocuments])
  useEffect(() => {
    if (!pending) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [pending])
  const run = async (action: () => Promise<void>) => {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (err) {
      setError(humanError(err))
      if (err instanceof ApiError && err.status === 401) setNeedsLogin(true)
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  async function dispatch(request: PendingOnlineRequest) {
    if (
      !boot ||
      request.actorId !== boot.userId ||
      request.deviceId !== boot.device?.id ||
      request.branchId !== boot.device.branchId
    )
      throw new Error('Sign in on the original enrolled counter to recover this request.')
    const result = await api(request.endpoint, 'POST', request.body)
    await confirmRequest(request, result)
  }
  async function recover(request: PendingOnlineRequest) {
    if (!boot || request.actorId !== boot.userId)
      throw new Error('Use the original account and browser to resolve this request.')
    const kind = request.endpoint === '/api/pos/sync' ? 'sale' : 'command'
    const original =
      kind === 'sale'
        ? liveOrderSchema.parse(request.body).order
        : liveCommandSchema.parse(request.body).command
    const result = await api('/api/pos/recovery', 'POST', { kind, request: original })
    if (
      result &&
      typeof result === 'object' &&
      'status' in result &&
      result.status === 'cancelled'
    ) {
      if (
        !('requestId' in result) ||
        result.requestId !== request.id ||
        !('kind' in result) ||
        result.kind !== kind
      )
        throw new Error('Cancellation did not match the saved request.')
      await acknowledgePendingRequest(request.actorId, request.id)
      setPending(null)
      setBasket([])
      setChosenOffer(null)
      setCashInput('')
      setCardInput('')
      setSelected(null)
      setNotice(
        'The server confirmed this request was not recorded and has permanently cancelled it. Reconcile any money already collected before starting another sale.'
      )
      await refresh()
      return
    }
    await confirmRequest(request, result)
  }
  async function confirmRequest(request: PendingOnlineRequest, result: unknown) {
    if (!result || typeof result !== 'object')
      throw new Error('The server response could not be verified. Retry the saved request.')
    let receipt: FiscalDocument | null = null
    if (request.endpoint === '/api/pos/sync') {
      if (
        !('status' in result) ||
        result.status !== 'synced' ||
        !('orderId' in result) ||
        result.orderId !== request.id ||
        !('receipt' in result)
      )
        throw new Error('Sale confirmation did not match. Keep this request for recovery.')
      receipt = fiscalDocumentSchema.parse(result.receipt)
      if (receipt.kind !== 'tax_invoice' || receipt.orderId !== request.id)
        throw new Error('Invoice confirmation did not match the saved sale.')
      const input = liveOrderSchema.parse(request.body).order
      if (!invoiceMatchesSale(input, receipt))
        throw new Error('Invoice amounts did not match the saved sale.')
    } else {
      if (
        !('status' in result) ||
        result.status !== 'applied' ||
        !('commandId' in result) ||
        result.commandId !== request.id
      )
        throw new Error('Action confirmation did not match. Keep this request for recovery.')
      if ('creditNote' in result) receipt = fiscalDocumentSchema.parse(result.creditNote)
      const input = liveCommandSchema.parse(request.body).command
      if (
        input.type === 'refund.full' &&
        (!receipt || receipt.kind !== 'tax_credit_note' || receipt.orderId !== input.orderId)
      )
        throw new Error('The credit note did not match the saved refund request.')
    }
    if (
      receipt &&
      (receipt.branchId !== request.branchId ||
        receipt.deviceId !== request.deviceId ||
        receipt.actorId !== request.actorId)
    )
      throw new Error(
        'Document identity did not match this counter. Keep the saved request for review.'
      )
    await acknowledgePendingRequest(request.actorId, request.id)
    setPending(null)
    if (request.endpoint === '/api/pos/sync') {
      setBasket([])
      setChosenOffer(null)
      setCashInput('')
      setCardInput('')
      setBuyerName('')
      setBuyerAddress('')
      setBuyerTrn('')
    }
    setNotice(
      receipt
        ? `${receipt.documentNumber} saved on the server.`
        : 'Counter action saved on the server.'
    )
    if (receipt) {
      setSelected(receipt)
      setView('receipts')
      setRefundReason('')
      setRefundConfirmed(false)
    }
    if ('cashDifferenceFils' in result && typeof result.cashDifferenceFils === 'number')
      setNotice(`Shift closed. Cash difference: ${currency(result.cashDifferenceFils)}.`)
    await refresh()
    if (receipt) await loadDocuments(request.branchId)
  }
  async function queue(endpoint: PendingOnlineRequest['endpoint'], id: string, body: unknown) {
    if (
      !boot ||
      !boot.device ||
      !branch?.profile ||
      !online ||
      !boot.capabilities.onlineSales ||
      !branch.canSell
    )
      throw new Error('An active enrolled counter and an internet connection are required.')
    const validated =
      endpoint === '/api/pos/sync' ? liveOrderSchema.parse(body) : liveCommandSchema.parse(body)
    const request = {
      actorId: boot.userId,
      deviceId: boot.device.id,
      branchId,
      id,
      endpoint,
      body: validated,
      savedAt: new Date().toISOString(),
    }
    try {
      await savePendingRequest(request)
    } catch (err) {
      setPending(await readPendingRequest(boot.userId))
      throw err
    }
    setPending(request)
    await dispatch(request)
  }
  const command = async (value: LiveCommand) =>
    queue('/api/pos/commands', value.id, { command: value })
  const checkout = () =>
    run(async () => {
      if (!boot?.device || !branch?.profile || !shift || !basket.length || total <= 0)
        throw new Error('Open your shift and add an item first.')
      if (
        basket.some(
          (line) =>
            !Number.isInteger(line.quantityMilli) ||
            line.quantityMilli <= 0 ||
            (line.product.unit !== 'kg' && line.quantityMilli % 1000 !== 0)
        )
      )
        throw new Error('Enter whole pieces or whole grams for every item.')
      const card =
        paymentMethod === 'card' ? total : paymentMethod === 'split' ? parseMoney(cardInput) : 0
      const cashApplied = total - card
      if (
        card < 0 ||
        card > total ||
        (paymentMethod === 'split' && (card === 0 || cashApplied === 0))
      )
        throw new Error('Split payment needs a positive cash and card amount.')
      const cashTenderedFils = cashApplied
        ? parseMoney(cashInput || formatFils(cashApplied).replaceAll(',', ''))
        : 0
      if (cashTenderedFils < cashApplied)
        throw new Error('Cash received is less than the amount due.')
      const hasCustomer = !!(buyerName.trim() || buyerAddress.trim() || buyerTrn.trim())
      if (hasCustomer && (!buyerName.trim() || !buyerAddress.trim()))
        throw new Error('Enter the customer name and address, or leave all customer fields blank.')
      if (buyerTrn.trim() && !/^\d{15}$/.test(buyerTrn.trim()))
        throw new Error('Customer TRN must have 15 digits.')
      if (total > 1_000_000 && !hasCustomer)
        throw new Error('Customer name and address are required above AED 10,000.')
      const order: LiveOrder = {
        id: crypto.randomUUID(),
        branchId,
        deviceId: boot.device.id,
        shiftId: shift.id,
        createdAt: new Date().toISOString(),
        serviceType,
        profileId: branch.profile.id,
        customer: hasCustomer
          ? { name: buyerName.trim(), address: buyerAddress.trim(), trn: buyerTrn.trim() || null }
          : null,
        cashTenderedFils,
        expectedTotalFils: total,
        lines: offerLines,
        ...(activeOffer ? { offerSelection: activeOffer.selection } : {}),
        payments: [
          ...(cashApplied ? [{ method: 'cash' as const, amountFils: cashApplied }] : []),
          ...(card ? [{ method: 'card' as const, amountFils: card }] : []),
        ],
      }
      await queue('/api/pos/sync', order.id, { order })
    })
  function add(product: Product) {
    if (pending || busy) return
    setBasket((current) => {
      const found = current.find((line) => line.product.id === product.id)
      return found
        ? current.map((line) =>
            line.product.id === product.id
              ? {
                  ...line,
                  quantityMilli: Math.min(
                    1_000_000,
                    line.quantityMilli + (product.unit === 'kg' ? 250 : 1000)
                  ),
                }
              : line
          )
        : [...current, { product, quantityMilli: product.unit === 'kg' ? 250 : 1000 }]
    })
  }
  function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = new FormData(form)
    void run(async () => {
      await api('/api/pos/session', 'POST', {
        email: String(values.get('email')).trim(),
        password: String(values.get('password')),
      })
      form.reset()
      await refresh()
      setNeedsLogin(false)
    })
  }
  if (loading)
    return (
      <main className="lc-app lc-centre">
        <p role="status">Opening your counter…</p>
      </main>
    )
  if (needsLogin)
    return (
      <main className="lc-app lc-centre">
        <form className="lc-login" onSubmit={login}>
          <Link href="/" className="lc-wordmark">
            Internext <strong>POS</strong>
          </Link>
          <span className="lc-eyebrow">Staff access</span>
          <h1>Your counter starts here.</h1>
          <p>Sign in with the account assigned to your restaurant.</p>
          <label>
            Email
            <input name="email" type="email" autoComplete="username" maxLength={254} required />
          </label>
          <label>
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              maxLength={128}
              required
            />
          </label>
          {error && (
            <p role="alert" className="lc-error">
              {error}
            </p>
          )}
          <button className="lc-primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <Link href="/pos">Open the separate training workspace</Link>
        </form>
      </main>
    )
  if (!boot)
    return (
      <main className="lc-app lc-centre">
        <section className="lc-login">
          <h1>Counter setup</h1>
          <p role="alert">{error || 'The account service is not ready yet.'}</p>
          <PendingAccessRecovery />
          <button
            onClick={() =>
              void run(async () => {
                await refresh()
              })
            }
            disabled={busy}
          >
            Check again
          </button>
          <Link href="/">Back to website</Link>
        </section>
      </main>
    )
  return (
    <div className="lc-app">
      <header className="lc-top lc-noprint">
        <Link href="/" className="lc-wordmark">
          Internext <strong>POS</strong>
        </Link>
        <div>
          <strong>{branch?.name || 'Your restaurant'}</strong>
          <span className={online ? 'lc-online' : 'lc-offline'}>
            {online ? 'Connected' : 'Offline · sales paused'}
          </span>
        </div>
        <button
          disabled={busy || !!pending}
          onClick={() =>
            void run(async () => {
              if (await readPendingRequest(boot.userId))
                throw new Error('Recover the pending request before signing out.')
              await api('/api/pos/session', 'DELETE')
              setBoot(null)
              setDocuments([])
              setSelected(null)
              setBasket([])
              setChosenOffer(null)
              setNeedsLogin(true)
            })
          }
        >
          Sign out
        </button>
      </header>
      <div className="lc-status lc-noprint">
        {(!boot.capabilities.onlineSales || !branch?.canSell) && (
          <p className="lc-warning">
            Your account is ready. Live counter activation is still pending; no real sale can be
            saved yet.
          </p>
        )}
        {!online && (
          <p className="lc-warning">
            Reconnect before taking another payment. This web counter requires server confirmation.
          </p>
        )}
        {error && (
          <p className="lc-error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="lc-success" role="status">
            {notice}
          </p>
        )}
        {pending && (
          <section className="lc-warning" aria-label="Pending request">
            <strong>A request needs confirmation</strong>
            <p>
              Do not take this payment again. Retry checks the same saved request and cannot issue a
              second invoice for it.
            </p>
            <small>Reference: {pending.id}</small>
            <button disabled={busy || !online} onClick={() => void run(() => dispatch(pending))}>
              {busy ? 'Checking…' : 'Recover saved request'}
            </button>
            <details>
              <summary>Resolve a rejected request</summary>
              <p>
                This checks the server first. If already recorded, its confirmation is restored.
                Otherwise the request is permanently cancelled. Reconcile any payment already
                collected before starting another sale.
              </p>
              <button disabled={busy || !online} onClick={() => void run(() => recover(pending))}>
                Resolve or cancel unsaved request
              </button>
            </details>
          </section>
        )}
      </div>
      {!boot.device ? (
        <main className="lc-enrol lc-noprint">
          <h1>Set up this counter</h1>
          <p>Give this browser a counter name. Each POS device keeps its own shift.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              const data = new FormData(event.currentTarget)
              void run(async () => {
                await api('/api/pos/devices', 'POST', {
                  branchId,
                  name: String(data.get('deviceName')).trim(),
                })
                await refresh()
              })
            }}
          >
            <label>
              Branch
              <select value={branchId} onChange={(event) => setBranchId(event.target.value)}>
                {boot.branches.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Counter name
              <input
                name="deviceName"
                required
                minLength={2}
                maxLength={80}
                placeholder="For example, Front counter"
              />
            </label>
            <button className="lc-primary" disabled={busy || !branchId || !!pending}>
              Register this counter
            </button>
          </form>
        </main>
      ) : (
        <>
          <nav className="lc-tabs lc-noprint" aria-label="Counter navigation">
            {(
              [
                'sell',
                'receipts',
                'shift',
                ...(manager ? ['menu', 'offers', 'reports', 'staff'] : []),
                'branch',
                'account',
              ] as View[]
            ).map((item) => (
              <button
                key={item}
                aria-current={view === item ? 'page' : undefined}
                onClick={() => setView(item)}
              >
                {
                  {
                    sell: 'Sell',
                    receipts: 'Receipts',
                    shift: 'Shift',
                    branch: 'Branch',
                    menu: 'Menu',
                    offers: 'Offers',
                    reports: 'Reports',
                    staff: 'Staff',
                    account: 'Account',
                  }[item]
                }
              </button>
            ))}
            <span>{boot.device.name}</span>
          </nav>
          <main className="lc-main">
            {view === 'staff' && manager && (
              <StaffManager
                key={`${boot.userId}:${branchId}`}
                actorId={boot.userId}
                branchId={branchId}
                deviceId={boot.device.id}
                disabled={busy || !!pending || !online}
                onChanged={async () => {
                  await refresh()
                }}
              />
            )}
            {view === 'account' && (
              <AccountSettings disabled={busy || !!pending || !online || !!shift} />
            )}
            {view === 'reports' && manager && branch && (
              <BranchReports
                key={`${boot.userId}:${branchId}`}
                branchId={branchId}
                branchName={branch.name}
              />
            )}
            {view === 'offers' && manager && (
              <OfferManager
                key={`${boot.userId}:${branchId}`}
                branchId={branchId}
                deviceId={boot.device.id}
                disabled={busy || !!pending || !online}
                onChanged={async () => {
                  setChosenOffer(null)
                  setCashInput('')
                  setCardInput('')
                }}
              />
            )}
            {view === 'menu' && manager && (
              <CatalogueManager
                key={`${boot.userId}:${branchId}`}
                branchId={branchId}
                deviceId={boot.device.id}
                disabled={busy || !!pending || !online}
                onChanged={async () => {
                  await refresh()
                  setBasket([])
                  setChosenOffer(null)
                  setCashInput('')
                  setCardInput('')
                }}
              />
            )}
            {view === 'sell' && (
              <div className="lc-sell lc-noprint">
                <section className="lc-menu">
                  <div className="lc-section-heading">
                    <div>
                      <span className="lc-eyebrow">{products.length} available items</span>
                      <h1>New order</h1>
                    </div>
                    <button
                      onClick={() =>
                        orderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                      }
                    >
                      Order · {basket.length}
                    </button>
                  </div>
                  <div className="lc-filters">
                    <label>
                      Search menu
                      <input
                        type="search"
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Find a dish or sweet"
                      />
                    </label>
                    <label>
                      Category
                      <select
                        value={category}
                        onChange={(event) => setCategory(event.target.value)}
                      >
                        <option>All</option>
                        {categories.map((item) => (
                          <option key={item}>{item}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="lc-products">
                    {visibleProducts.map((product) => (
                      <button
                        key={product.id}
                        className="lc-product"
                        disabled={busy || !!pending || product.unitPriceFils <= 0}
                        onClick={() => add(product)}
                      >
                        {product.imageUrl?.startsWith('/pos-assets/') ? (
                          <img src={product.imageUrl} alt="" loading="lazy" />
                        ) : (
                          <span className="lc-photo-empty">Photo to add</span>
                        )}
                        <span>{product.name}</span>
                        <strong>
                          {currency(product.unitPriceFils)}
                          {product.unit === 'kg' ? ' / kg' : ''}
                        </strong>
                      </button>
                    ))}
                  </div>
                  {!visibleProducts.length && <p>No available items match your search.</p>}
                </section>
                <aside className="lc-order" ref={orderRef} aria-label="Current order">
                  <h2>Current order</h2>
                  <p>{shift ? 'Shift open' : 'Open your shift before checkout'}</p>
                  <label>
                    Order type
                    <select
                      value={serviceType}
                      disabled={busy || !!pending}
                      onChange={(event) =>
                        setServiceType(event.target.value as LiveOrder['serviceType'])
                      }
                    >
                      <option value="takeaway">Takeaway</option>
                      <option value="dine_in">Dine-in</option>
                      <option value="delivery">Delivery</option>
                    </select>
                  </label>
                  {!basket.length && <p className="lc-empty">Choose an item to start an order.</p>}
                  {basket.map((line) => (
                    <div className="lc-basket-line" key={line.product.id}>
                      <strong>{line.product.name}</strong>
                      <span>
                        {currency(
                          catalogueLineTotals(
                            line.product.unitPriceFils,
                            line.quantityMilli,
                            line.product.taxRateBps
                          ).grossFils
                        )}
                      </span>
                      <label>
                        {line.product.unit === 'kg' ? 'Grams' : 'Quantity'}
                        <input
                          type="number"
                          inputMode="numeric"
                          min="1"
                          max={line.product.unit === 'kg' ? 1000000 : 1000}
                          step="1"
                          value={
                            line.product.unit === 'kg'
                              ? line.quantityMilli
                              : line.quantityMilli / 1000
                          }
                          disabled={busy || !!pending}
                          onChange={(event) => {
                            const quantity = Number(event.target.value)
                            const scaled = quantity * (line.product.unit === 'kg' ? 1 : 1000)
                            if (
                              !Number.isSafeInteger(quantity) ||
                              quantity < 1 ||
                              scaled > 1_000_000
                            ) {
                              setError('Use whole quantities within the counter limit.')
                              return
                            }
                            setBasket((current) =>
                              current.map((item) =>
                                item.product.id === line.product.id
                                  ? { ...item, quantityMilli: scaled }
                                  : item
                              )
                            )
                          }}
                        />
                      </label>
                      <button
                        disabled={busy || !!pending}
                        aria-label={`Remove ${line.product.name}`}
                        onClick={() =>
                          setBasket((current) =>
                            current.filter((item) => item.product.id !== line.product.id)
                          )
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  {basket.length > 0 && (
                    <OfferPicker
                      key={`${boot.userId}:${branchId}`}
                      branchId={branchId}
                      serviceType={serviceType}
                      lines={offerLines}
                      disabled={busy || !!pending || !online}
                      onSelection={chooseOffer}
                    />
                  )}
                  <dl className="lc-totals">
                    {activeOffer && (
                      <>
                        <div>
                          <dt>Before offer</dt>
                          <dd>{currency(beforeDiscount)}</dd>
                        </div>
                        <div>
                          <dt>{activeOffer.quote.offerName}</dt>
                          <dd>−{currency(activeOffer.quote.discountFils)}</dd>
                        </div>
                      </>
                    )}
                    <div>
                      <dt>VAT included</dt>
                      <dd>{currency(tax)}</dd>
                    </div>
                    <div>
                      <dt>Total</dt>
                      <dd>{currency(total)}</dd>
                    </div>
                  </dl>
                  <label>
                    Payment
                    <select
                      value={paymentMethod}
                      disabled={busy || !!pending}
                      onChange={(event) =>
                        setPaymentMethod(event.target.value as typeof paymentMethod)
                      }
                    >
                      <option value="cash">Cash</option>
                      <option value="card">Card recorded</option>
                      <option value="split">Cash + card</option>
                    </select>
                  </label>
                  {paymentMethod === 'split' && (
                    <label>
                      Card amount (AED)
                      <input
                        inputMode="decimal"
                        value={cardInput}
                        disabled={busy || !!pending}
                        onChange={(event) => setCardInput(event.target.value)}
                      />
                    </label>
                  )}
                  {paymentMethod !== 'card' && (
                    <label>
                      Cash received (AED)
                      <input
                        inputMode="decimal"
                        placeholder={paymentMethod === 'cash' ? formatFils(total) : 'Cash amount'}
                        value={cashInput}
                        disabled={busy || !!pending}
                        onChange={(event) => setCashInput(event.target.value)}
                      />
                    </label>
                  )}
                  {paymentMethod !== 'cash' && (
                    <p className="lc-help">
                      Complete the card payment on your terminal first. This button records it; it
                      does not charge a card.
                    </p>
                  )}
                  <details>
                    <summary>Customer details for the invoice</summary>
                    <label>
                      Name
                      <input
                        maxLength={200}
                        value={buyerName}
                        disabled={busy || !!pending}
                        onChange={(event) => setBuyerName(event.target.value)}
                      />
                    </label>
                    <label>
                      Address
                      <input
                        maxLength={400}
                        value={buyerAddress}
                        disabled={busy || !!pending}
                        onChange={(event) => setBuyerAddress(event.target.value)}
                      />
                    </label>
                    <label>
                      TRN, if registered
                      <input
                        inputMode="numeric"
                        maxLength={15}
                        value={buyerTrn}
                        disabled={busy || !!pending}
                        onChange={(event) => setBuyerTrn(event.target.value)}
                      />
                    </label>
                  </details>
                  <button
                    className="lc-primary"
                    disabled={!mayWrite || !shift || total <= 0}
                    onClick={checkout}
                  >
                    {busy ? 'Waiting for confirmation…' : `Save sale · ${currency(total)}`}
                  </button>
                  {!shift && <button onClick={() => setView('shift')}>Go to shift</button>}
                  <p className="lc-help">
                    An invoice appears only after the server confirms the sale.
                  </p>
                </aside>
              </div>
            )}
            {view === 'receipts' && (
              <section className="lc-documents">
                <div className="lc-noprint">
                  <div className="lc-section-heading">
                    <h1>Receipts</h1>
                    <button
                      disabled={busy || !online}
                      onClick={() => void run(() => loadDocuments(branchId))}
                    >
                      Refresh
                    </button>
                  </div>
                  <p>
                    Saved invoices and credit notes for this branch. Reprinting does not create
                    another sale.
                  </p>
                  <div className="lc-document-list">
                    {documents.map((document) => (
                      <button
                        key={document.id}
                        aria-pressed={selected?.id === document.id}
                        onClick={() => {
                          setSelected(document)
                          setRefundReason('')
                          setRefundConfirmed(false)
                        }}
                      >
                        <strong>{document.documentNumber}</strong>
                        <span>
                          {document.kind === 'tax_credit_note' ? 'Credit note' : 'Invoice'} ·{' '}
                          {currency(document.totals.grossFils)}
                        </span>
                      </button>
                    ))}
                    {!documents.length && <p>No saved receipts yet.</p>}
                    {nextCursor && (
                      <button
                        disabled={busy || !online}
                        onClick={() => void run(() => loadDocuments(branchId, nextCursor))}
                      >
                        Load older receipts
                      </button>
                    )}
                  </div>
                </div>
                {selected && (
                  <div className="lc-document-detail">
                    <FiscalReceipt document={selected} />
                    <div className="lc-noprint">
                      <button className="lc-primary" onClick={() => window.print()}>
                        Print / save PDF
                      </button>
                      <p className="lc-help">
                        Choose the printer or Save as PDF in the browser dialog. Printer delivery is
                        not confirmed by this app.
                      </p>
                      {selectedCredited && (
                        <p className="lc-warning">
                          This invoice already has a full credit note. Do not return the money
                          again.
                        </p>
                      )}
                      {selected.kind === 'tax_credit_note' && (
                        <p className="lc-warning">
                          Return the amounts shown only once for this credit note. Card refunds must
                          be completed on your payment terminal; this app does not process them.
                        </p>
                      )}
                      {selected.kind === 'tax_invoice' && manager && !selectedCredited && (
                        <details>
                          <summary>Full return &amp; credit note</summary>
                          <p>
                            This reverses the entire invoice. Wait for the credit note before
                            returning money. Partial refunds are not available in this pilot.
                          </p>
                          <label>
                            Reason
                            <input
                              value={refundReason}
                              maxLength={240}
                              onChange={(event) => setRefundReason(event.target.value)}
                            />
                          </label>
                          <label className="lc-check">
                            <input
                              type="checkbox"
                              checked={refundConfirmed}
                              onChange={(event) => setRefundConfirmed(event.target.checked)}
                            />
                            I confirm the full order is being returned.
                          </label>
                          <button
                            disabled={
                              !mayWrite || !shift || !refundReason.trim() || !refundConfirmed
                            }
                            onClick={() =>
                              void run(async () => {
                                if (!boot.device || !shift)
                                  throw new Error('Open your shift first.')
                                await command({
                                  id: crypto.randomUUID(),
                                  type: 'refund.full',
                                  branchId,
                                  deviceId: boot.device.id,
                                  shiftId: shift.id,
                                  orderId: selected.orderId,
                                  reason: refundReason.trim(),
                                })
                              })
                            }
                          >
                            Issue full credit note
                          </button>
                        </details>
                      )}
                    </div>
                  </div>
                )}
              </section>
            )}
            {view === 'shift' && (
              <section className="lc-shift lc-noprint">
                <h1>Your shift</h1>
                <p>
                  {boot.device.name} · {branch?.name}
                </p>
                {otherShift && (
                  <p className="lc-warning">
                    Another staff member has an open shift on this counter. They must sign in and
                    close it first.
                  </p>
                )}
                {shift ? (
                  <>
                    <div className="lc-summary">
                      <div>
                        <span>Opening cash</span>
                        <strong>{currency(shift.openingCashFils)}</strong>
                      </div>
                      <div>
                        <span>Expected cash now</span>
                        <strong>
                          {'expectedCashFils' in shift && typeof shift.expectedCashFils === 'number'
                            ? currency(shift.expectedCashFils)
                            : 'Refresh to view'}
                        </strong>
                      </div>
                    </div>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await refresh()
                        })
                      }
                    >
                      Refresh shift totals
                    </button>
                    <form
                      onSubmit={(event) => {
                        event.preventDefault()
                        const data = new FormData(event.currentTarget)
                        void run(async () => {
                          if (!boot.device) return
                          if (basket.length)
                            throw new Error(
                              'Finish or remove the current order before closing your shift.'
                            )
                          await command({
                            id: crypto.randomUUID(),
                            type: 'shift.close',
                            branchId,
                            deviceId: boot.device.id,
                            shiftId: shift.id,
                            countedCashFils: parseMoney(String(data.get('counted'))),
                          })
                        })
                      }}
                    >
                      <h2>Close shift</h2>
                      <label>
                        Cash counted (AED)
                        <input name="counted" inputMode="decimal" required />
                      </label>
                      <button className="lc-primary" disabled={!mayWrite}>
                        Reconcile &amp; close shift
                      </button>
                    </form>
                    {manager && (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault()
                          const form = event.currentTarget
                          const data = new FormData(form)
                          void run(async () => {
                            if (!boot.device) return
                            const amount = parseMoney(String(data.get('amount')))
                            if (amount <= 0) throw new Error('Enter an amount above zero.')
                            await command({
                              id: crypto.randomUUID(),
                              type: 'cash.move',
                              branchId,
                              deviceId: boot.device.id,
                              shiftId: shift.id,
                              amountFils: amount * (data.get('direction') === 'out' ? -1 : 1),
                              reason: String(data.get('reason')).trim(),
                            })
                            form.reset()
                          })
                        }}
                      >
                        <h2>Cash movement</h2>
                        <label>
                          Direction
                          <select name="direction">
                            <option value="in">Cash in</option>
                            <option value="out">Cash out</option>
                          </select>
                        </label>
                        <label>
                          Amount (AED)
                          <input name="amount" inputMode="decimal" required />
                        </label>
                        <label>
                          Reason
                          <input name="reason" required maxLength={240} />
                        </label>
                        <button disabled={!mayWrite}>Record cash movement</button>
                      </form>
                    )}
                  </>
                ) : (
                  !otherShift && (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault()
                        const data = new FormData(event.currentTarget)
                        void run(async () => {
                          if (!boot.device) return
                          await command({
                            id: crypto.randomUUID(),
                            type: 'shift.open',
                            branchId,
                            deviceId: boot.device.id,
                            shiftId: crypto.randomUUID(),
                            openingCashFils: parseMoney(String(data.get('opening'))),
                          })
                        })
                      }}
                    >
                      <h2>Open shift</h2>
                      <label>
                        Cash in the drawer (AED)
                        <input name="opening" inputMode="decimal" defaultValue="0.00" required />
                      </label>
                      <button className="lc-primary" disabled={!mayWrite}>
                        Open shift
                      </button>
                    </form>
                  )
                )}
              </section>
            )}
            {view === 'branch' && (
              <section className="lc-branch lc-noprint">
                <h1>Branch details</h1>
                {branch?.profile ? (
                  <>
                    <h2>{branch.profile.legalName}</h2>
                    <p>
                      {branch.profile.address}
                      <br />
                      {branch.profile.phone}
                    </p>
                    <p>
                      <strong>VAT TRN:</strong> {branch.profile.trn}
                      <br />
                      <strong>Prices:</strong> VAT inclusive
                      <br />
                      <strong>Currency:</strong> AED
                    </p>
                  </>
                ) : (
                  <p className="lc-warning">
                    Business details must be confirmed before live billing.
                  </p>
                )}
                <hr />
                <h2>Counter access</h2>
                <p>
                  {boot.device.name}
                  <br />
                  {branch?.role} access
                </p>
                <h2>Subscription</h2>
                <p>
                  AED 100 per branch per month. Collection is manual; this screen is not proof of
                  payment.
                </p>
                <h2>Current live pilot</h2>
                <p>
                  Online sales, recorded cash/card payments, weighted items, invoice reprints, shift
                  closing, offers and full refunds. Shared tables, kitchen dispatch, partial refunds
                  and offline live sales are still being prepared.
                </p>
                <Link href="/pos">Open separate training workspace</Link>
              </section>
            )}
          </main>
        </>
      )}
    </div>
  )
}

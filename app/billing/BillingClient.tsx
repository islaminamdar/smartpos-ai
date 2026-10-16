'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { z } from 'zod'
const bootSchema = z.object({
  userId: z.string().uuid(),
  branches: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      role: z.enum(['owner', 'manager', 'cashier']),
    })
  ),
})
const stateSchema = z.object({
  environment: z.enum(['sandbox', 'live']),
  subscription: z
    .object({
      id: z.string().uuid(),
      status: z.string(),
      price_review_required: z.boolean().default(false),
      checked_at: z.string().nullable(),
      next_billing_time: z.string().nullable(),
      last_payment_cents: z.number().nullable(),
      last_payment_at: z.string().nullable(),
    })
    .nullable(),
  transactions: z.array(
    z.object({
      provider_transaction_id: z.string(),
      status: z.string(),
      amount_cents: z.number(),
      occurred_at: z.string(),
    })
  ),
})
type BillingState = z.infer<typeof stateSchema>
async function api(path: string, body?: unknown) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  })
  const result = await response.json()
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? 'Please sign in at the counter first.'
        : result.code === 'paypal_not_configured'
          ? 'PayPal checkout is not available yet. Your current branch service is unchanged.'
          : response.status === 403
            ? 'Only a manager or owner can manage this branch subscription.'
            : 'Confirmation is pending. Check PayPal status before trying again. Your counter sales are unchanged.'
    )
  return result
}
const date = (value: string | null) => (value ? new Date(value).toLocaleString() : 'Not available')
export default function BillingClient() {
  const [branches, setBranches] = useState<z.infer<typeof bootSchema>['branches']>([])
  const [branch, setBranch] = useState(''),
    [actor, setActor] = useState(''),
    [state, setState] = useState<BillingState | null>(null)
  const [message, setMessage] = useState('Loading your branches…'),
    [busy, setBusy] = useState(false),
    [agree, setAgree] = useState(false),
    [cancelAgree, setCancelAgree] = useState(false),
    [approval, setApproval] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    api('/api/pos/bootstrap')
      .then((data) => {
        const boot = bootSchema.parse(data)
        if (!active) return
        const allowed = boot.branches.filter((b) => b.role !== 'cashier')
        setActor(boot.userId)
        setBranches(allowed)
        const wanted = new URLSearchParams(location.search).get('branchId')
        setBranch(allowed.find((b) => b.id === wanted)?.id ?? allowed[0]?.id ?? '')
        setMessage(allowed.length ? '' : 'No branch billing access. Ask your branch owner.')
      })
      .catch((error) => {
        if (active) setMessage(error.message)
      })
    return () => {
      active = false
    }
  }, [])
  useEffect(() => {
    let active = true
    setState(null)
    setAgree(false)
    setCancelAgree(false)
    setApproval(null)
    if (!branch) return
    api('/api/billing/paypal/status?branchId=' + branch)
      .then((data) => {
        if (active) {
          const latest = stateSchema.parse(data)
          setState(latest)
          if (['CANCELLED', 'EXPIRED'].includes(latest.subscription?.status ?? ''))
            localStorage.removeItem(`pos-paypal-request:${actor}:${branch}`)
          setMessage('')
        }
      })
      .catch((error) => {
        if (active) setMessage(error.message)
      })
    return () => {
      active = false
    }
  }, [branch, actor])
  async function action(kind: 'checkout' | 'reconcile' | 'cancel') {
    setBusy(true)
    setMessage('Checking with PayPal…')
    setApproval(null)
    try {
      const key = `pos-paypal-request:${actor}:${branch}`
      let requestId = localStorage.getItem(key)
      if (!requestId) {
        requestId = crypto.randomUUID()
        localStorage.setItem(key, requestId)
      }
      const body =
        kind === 'checkout'
          ? { branchId: branch, requestId, acceptRecurring: true }
          : kind === 'cancel'
            ? { branchId: branch, confirmCancellation: true }
            : { branchId: branch }
      const result = await api('/api/billing/paypal/' + kind, body)
      const fresh = stateSchema.parse(await api('/api/billing/paypal/status?branchId=' + branch))
      setState(fresh)
      if (['CANCELLED', 'EXPIRED'].includes(fresh.subscription?.status ?? ''))
        localStorage.removeItem(key)
      if (result.approvalUrl) {
        const url = new URL(result.approvalUrl)
        if (
          url.protocol !== 'https:' ||
          url.hostname !==
            (fresh.environment === 'live' ? 'www.paypal.com' : 'www.sandbox.paypal.com')
        )
          throw new Error('PayPal approval link could not be confirmed.')
        setApproval(url.href)
        setMessage('Your checkout is ready. Review and approve the recurring payment on PayPal.')
      } else
        setMessage(
          result.reconciliationPending
            ? 'Earlier payments are still being checked. Select Check PayPal again.'
            : 'The latest status below was confirmed with PayPal.'
        )
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : 'Could not confirm billing status. Please check again.'
      )
    } finally {
      setBusy(false)
    }
  }
  const current = state?.subscription,
    terminal = !current || ['CANCELLED', 'EXPIRED'].includes(current.status)
  return (
    <main className="billing-shell">
      <header className="billing-nav">
        <Link href="/" className="billing-brand">
          internext<span> / billing</span>
        </Link>
        <Link href="/counter">Back to counter ↗</Link>
      </header>
      <section className="billing-intro">
        <span className="billing-eyebrow">YOUR BRANCH SUBSCRIPTION</span>
        <h1>
          One branch.
          <br />
          Everything included.
        </h1>
        <p>
          Manage recurring payments for an existing restaurant branch. Your sales records remain
          separate from billing.
        </p>
      </section>
      <div className="billing-grid">
        <section className="billing-card">
          <div className="billing-price">
            US$100 <span>/ month / branch</span>
          </div>
          <p>
            All POS features, unlimited staff and multiple counter devices. Features still in
            preparation, including offline live sales and Android deployment, become available when
            released.
          </p>
          <label className="billing-field">
            Restaurant branch
            <select
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              disabled={busy || !branches.length}
            >
              {!branches.length && <option value="">Sign in to select a branch</option>}
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          {state?.environment === 'sandbox' && (
            <p className="billing-sandbox">
              PayPal sandbox — test environment. This does not activate a real paid subscription.
            </p>
          )}
          <p className="billing-terms">
            US$100 is charged every month for the selected branch until cancelled. Review the start
            date and recurring terms on PayPal before approving. Cancellation stops future recurring
            charges once PayPal confirms it; it does not refund earlier payments.
          </p>
          {(!current || terminal || ['CREATING', 'APPROVAL_PENDING'].includes(current.status)) && (
            <>
              <label className="billing-check">
                <input
                  type="checkbox"
                  checked={agree}
                  onChange={(e) => setAgree(e.target.checked)}
                  disabled={busy}
                />
                <span>I agree to US$100 per month for this branch, recurring until cancelled.</span>
              </label>
              <button
                disabled={!state || !branch || !agree || busy}
                onClick={() => action('checkout')}
              >
                Prepare PayPal checkout ↗
              </button>
            </>
          )}
          {approval && (
            <a className="billing-approve" href={approval} rel="noopener noreferrer">
              Continue to PayPal to approve ↗
            </a>
          )}
          <p className="billing-note">
            Existing manual subscription arrangements are unchanged by visiting this page.
          </p>
        </section>
        <section className="billing-card">
          <h2>Payment status</h2>
          <p role="status" aria-live="polite" className="billing-message">
            {message}
          </p>
          {state && (
            <>
              {current?.price_review_required && (
                <p className="billing-sandbox">
                  This agreement’s pricing or plan needs review. Contact the branch owner before
                  making another payment. You can still cancel future recurring payments.
                </p>
              )}
              <dl>
                <div>
                  <dt>Subscription</dt>
                  <dd>{current?.status.replaceAll('_', ' ') ?? 'Not started'}</dd>
                </div>
                <div>
                  <dt>Last checked</dt>
                  <dd>{date(current?.checked_at ?? null)}</dd>
                </div>
                <div>
                  <dt>Next billing</dt>
                  <dd>{date(current?.next_billing_time ?? null)}</dd>
                </div>
              </dl>
              <p className="billing-note">
                Subscription status and completed payments are different. Returning from PayPal
                alone does not confirm payment.
              </p>
              {current && (
                <button
                  className="billing-secondary"
                  disabled={busy}
                  onClick={() => action('reconcile')}
                >
                  Check PayPal
                </button>
              )}
              {current && !terminal && (
                <div className="billing-cancel">
                  <label className="billing-check">
                    <input
                      type="checkbox"
                      checked={cancelAgree}
                      onChange={(e) => setCancelAgree(e.target.checked)}
                      disabled={busy}
                    />
                    <span>Stop future recurring payments for this branch.</span>
                  </label>
                  <button
                    className="billing-secondary"
                    disabled={busy || !cancelAgree}
                    onClick={() => action('cancel')}
                  >
                    Cancel recurring subscription
                  </button>
                </div>
              )}
            </>
          )}
          <Link className="billing-signin" href="/counter">
            Sign in or return to your counter →
          </Link>
        </section>
      </div>
      {state && (
        <section className="billing-card billing-ledger">
          <h2>Recent PayPal payments</h2>
          {!state.transactions.length ? (
            <p>No confirmed payment records available.</p>
          ) : (
            <ul>
              {state.transactions.map((tx) => (
                <li key={tx.provider_transaction_id}>
                  <div>
                    <strong>US${(tx.amount_cents / 100).toFixed(2)}</strong>
                    <span>{date(tx.occurred_at)}</span>
                  </div>
                  <div>
                    <strong>{tx.status.replaceAll('_', ' ')}</strong>
                    <span>{tx.provider_transaction_id}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <footer className="billing-footer">
        Internext POS · Branch billing · <Link href="/">Product overview</Link>
      </footer>
    </main>
  )
}

'use client'
import { useLayoutEffect, useRef, useState } from 'react'
import type { OfferQuote } from '@/lib/pos/offers'
import { formatFils } from '@/lib/pos/money'
import type { LiveOrder } from '@/lib/pos/server/live-contracts'
import { offerQuoteResponseSchema, type OfferSelection } from '@/lib/pos/server/offers'
import styles from './offers.module.css'
export type { OfferSelection } from '@/lib/pos/server/offers'
export type EligibleOfferQuote = Extract<OfferQuote, { eligible: true }>
export default function OfferPicker({
  branchId,
  serviceType,
  lines,
  disabled,
  onSelection,
}: {
  branchId: string
  serviceType: LiveOrder['serviceType']
  lines: LiveOrder['lines']
  disabled: boolean
  onSelection: (selection: OfferSelection | null, quote: EligibleOfferQuote | null) => void
}) {
  const [coupon, setCoupon] = useState('')
  const [quotes, setQuotes] = useState<EligibleOfferQuote[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [checked, setChecked] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const callback = useRef(onSelection)
  callback.current = onSelection
  const signature = JSON.stringify({ branchId, serviceType, lines, coupon })
  useLayoutEffect(() => {
    generation.current++
    setQuotes([])
    setSelected(null)
    setChecked(false)
    setError('')
    setBusy(false)
    callback.current(null, null)
    return () => {
      generation.current++
    }
  }, [signature])
  async function check() {
    if (disabled || busy || !lines.length) return
    const request = ++generation.current
    setBusy(true)
    setError('')
    setSelected(null)
    setQuotes([])
    setChecked(false)
    callback.current(null, null)
    try {
      const response = await fetch('/api/pos/offers/quote', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          branchId,
          serviceType,
          lines,
          couponCode: coupon.trim().toUpperCase() || null,
        }),
        signal: AbortSignal.timeout(20000),
      })
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? 'Sign in again before checking offers.'
            : 'Offers could not be checked. Refresh the menu and try again.'
        )
      const result = offerQuoteResponseSchema.parse(await response.json())
      if (result.branchId !== branchId)
        throw new Error('The offers did not match this branch. Please try again.')
      if (request !== generation.current) return
      setQuotes(result.quotes)
      setChecked(true)
    } catch (cause) {
      if (request === generation.current)
        setError(
          cause instanceof Error && cause.name === 'Error'
            ? cause.message
            : 'Offers could not be checked. Check your connection and try again.'
        )
    } finally {
      if (request === generation.current) setBusy(false)
    }
  }
  function choose(quote: EligibleOfferQuote | null) {
    if (disabled || busy) return
    setSelected(quote?.offerId ?? null)
    callback.current(
      quote
        ? {
            offerId: quote.offerId,
            expectedRevision: quote.offerRevision,
            couponCode: coupon.trim().toUpperCase() || null,
            expectedDiscountFils: quote.discountFils,
          }
        : null,
      quote
    )
  }
  return (
    <section className={styles.picker} aria-label="Order offers">
      <div className={styles.heading}>
        <h3>Offer for this order</h3>
        <span>One offer per order</span>
      </div>
      <div className={styles.coupon}>
        <label>
          Coupon code (optional)
          <input
            value={coupon}
            maxLength={32}
            disabled={disabled}
            autoCapitalize="characters"
            autoComplete="off"
            onChange={(event) => setCoupon(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={disabled || busy || !lines.length}
          onClick={() => void check()}
        >
          {busy ? 'Checking…' : 'Check offers'}
        </button>
      </div>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {checked && !quotes.length && (
        <p>
          No eligible offer for this basket and coupon. You can continue at the normal menu price.
        </p>
      )}
      {!!quotes.length && (
        <fieldset disabled={disabled || busy} className={styles.choices}>
          <legend>Choose one saving</legend>
          <label className={styles.choice}>
            <input
              type="radio"
              name={`offer-${branchId}`}
              checked={!selected}
              onChange={() => choose(null)}
            />
            <span>No offer · normal menu price</span>
          </label>
          {quotes.map((quote) => (
            <label className={styles.choice} key={quote.offerId}>
              <input
                type="radio"
                name={`offer-${branchId}`}
                checked={selected === quote.offerId}
                onChange={() => choose(quote)}
              />
              <span>
                <strong>{quote.offerName}</strong>
                <small>
                  Save AED {formatFils(quote.discountFils)} · total AED{' '}
                  {formatFils(quote.grossFils)}
                </small>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {selected && (
        <p role="status" className={styles.notice}>
          Selected: {quotes.find((quote) => quote.offerId === selected)?.offerName}. The saving is
          checked again when the sale is saved.
        </p>
      )}
      <p className={styles.help}>
        Checking does not reserve an offer. Basket, service or coupon changes clear your selection.
      </p>
    </section>
  )
}

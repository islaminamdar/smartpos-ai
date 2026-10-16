'use client'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import {
  readPendingRequest,
  acknowledgePendingRequest,
  type PendingOnlineRequest,
} from '@/lib/pos/online-journal'
import { liveCommandSchema, liveOrderSchema } from '@/lib/pos/server/live-contracts'
import { fiscalDocumentSchema, type FiscalDocument } from '@/lib/pos/server/documents'
import { invoiceMatchesSale } from '@/lib/pos/server/sale-ack'
import FiscalReceipt from '../FiscalReceipt'
import styles from './staff.module.css'
const sessionSchema = z.object({ userId: z.string().uuid() })
async function actor() {
  const response = await fetch('/api/pos/session', {
    cache: 'no-store',
    credentials: 'same-origin',
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok)
    throw new Error('Sign in with the original account to check its saved counter request.')
  return sessionSchema.parse(await response.json()).userId
}
export default function PendingAccessRecovery() {
  const [pending, setPending] = useState<PendingOnlineRequest | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [receipt, setReceipt] = useState<FiscalDocument | null>(null)
  const lock = useRef(false)
  useEffect(() => {
    let mounted = true
    void (async () => {
      try {
        const id = await actor(),
          saved = await readPendingRequest(id)
        if (saved && saved.actorId !== id)
          throw new Error(
            'The saved request does not match this account. Keep browser data and contact your manager.'
          )
        if (mounted) setPending(saved)
      } catch {
        if (mounted)
          setError(
            'Saved counter work could not be checked. Sign in with the original account and keep this browser’s data.'
          )
      } finally {
        if (mounted) setLoading(false)
      }
    })()
    return () => {
      mounted = false
    }
  }, [])
  async function resolve() {
    if (!pending || lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      if ((await actor()) !== pending.actorId)
        throw new Error('Use the original signed-in account to resolve this request.')
      const kind =
        pending.endpoint === '/api/pos/sync'
          ? 'sale'
          : pending.endpoint === '/api/pos/commands'
            ? 'command'
            : null
      if (!kind)
        throw new Error(
          'The saved request could not be verified. Keep browser data and contact your manager.'
        )
      const original =
        kind === 'sale'
          ? liveOrderSchema.parse(pending.body).order
          : liveCommandSchema.parse(pending.body).command
      if (
        original.id !== pending.id ||
        original.branchId !== pending.branchId ||
        original.deviceId !== pending.deviceId
      )
        throw new Error('Saved request identity does not match. Keep this request for review.')
      const response = await fetch('/api/pos/recovery', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, request: original }),
        signal: AbortSignal.timeout(20000),
      })
      const result = await response.json()
      if (!response.ok)
        throw new Error(
          result?.code === 'staff_inactive'
            ? 'This request was not confirmed as saved. Ask your manager to restore your access, then retry from this browser. Do not collect payment again or clear browser data.'
            : 'Recovery could not be confirmed. Keep the saved request and use the original account and counter. No new sale was sent.'
        )
      let document: FiscalDocument | null = null
      const cancelled =
        result?.status === 'cancelled' && result.requestId === pending.id && result.kind === kind
      if (!cancelled) {
        if (kind === 'sale') {
          if (result?.status !== 'synced' || result.orderId !== pending.id)
            throw new Error(
              'The response did not match the saved sale. Keep this request for review.'
            )
          document = fiscalDocumentSchema.parse(result.receipt)
          if (
            document.kind !== 'tax_invoice' ||
            !invoiceMatchesSale(liveOrderSchema.parse(pending.body).order, document)
          )
            throw new Error(
              'The invoice did not match the saved sale. Keep this request for review.'
            )
        } else {
          if (result?.status !== 'applied' || result.commandId !== pending.id)
            throw new Error(
              'The response did not match the saved action. Keep this request for review.'
            )
          const command = liveCommandSchema.parse(pending.body).command
          if (command.type === 'refund.full') {
            document = fiscalDocumentSchema.parse(result.creditNote)
            if (document.kind !== 'tax_credit_note' || document.orderId !== command.orderId)
              throw new Error(
                'The credit note did not match the saved refund. Keep this request for review.'
              )
          }
        }
        if (
          document &&
          (document.actorId !== pending.actorId ||
            document.branchId !== pending.branchId ||
            document.deviceId !== pending.deviceId)
        )
          throw new Error(
            'The document belongs to another account or counter. Keep this request for review.'
          )
      }
      await acknowledgePendingRequest(pending.actorId, pending.id)
      setPending(null)
      setReceipt(document)
      setNotice(
        cancelled
          ? 'The server confirmed this request was not recorded and permanently cancelled it. Reconcile any money already collected or returned with your manager before starting another sale.'
          : 'The server confirmed the original request was saved. Its local pending record is now resolved. No duplicate sale was sent.'
      )
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name === 'Error'
          ? cause.message
          : 'Recovery could not be verified. Keep browser data and retry the same saved request when connected.'
      )
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return (
    <section className={styles.account} aria-label="Recover saved counter work">
      <h2>Saved counter work</h2>
      <p>
        You can check an earlier request even when branch access is unavailable. This does not
        restore access or start a new sale.
      </p>
      {loading ? (
        <p role="status">Checking this account’s saved work…</p>
      ) : pending ? (
        <div className={styles.pending}>
          <p>
            A counter request is still awaiting confirmation. Keep this browser’s data and use the
            original account.
          </p>
          <button onClick={() => void resolve()} disabled={busy}>
            {busy ? 'Checking saved request…' : 'Check saved request'}
          </button>
        </div>
      ) : !error && !notice ? (
        <p>No pending request was found for this signed-in account on this browser.</p>
      ) : null}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      {receipt && <FiscalReceipt document={receipt} />}
    </section>
  )
}

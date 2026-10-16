'use client'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import {
  inventoryRecoverySchema,
  inventoryResultMatches,
  type InventoryCommand,
} from '@/lib/pos/inventory'
import { clearStockRequest, readStockRequests, stockJournalEvent } from './journal'
import styles from './inventory.module.css'

async function currentActor() {
  const response = await fetch('/api/pos/session', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error('authentication_required')
  return z.object({ userId: z.string().uuid() }).parse(await response.json()).userId
}
export default function PendingStockRecovery(props: {
  actorId?: string
  excludeBranchId?: string
  excludeDeviceId?: string
  disabled?: boolean
}) {
  return <Recovery key={props.actorId ?? 'verify-session'} {...props} />
}
function Recovery({
  actorId,
  excludeBranchId,
  excludeDeviceId,
  disabled,
}: {
  actorId?: string
  excludeBranchId?: string
  excludeDeviceId?: string
  disabled?: boolean
}) {
  const [actor, setActor] = useState<string | null>(actorId ?? null)
  const [requests, setRequests] = useState<InventoryCommand[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    let generation = 0
    const read = async () => {
      const sequence = ++generation
      try {
        // Only inspect key names before the server identifies the account. Never read another actor's values.
        if (
          !actorId &&
          !Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).some(
            (value) => value?.startsWith('pos-stock-request:')
          )
        )
          return
        const verified = actorId ?? (await currentActor())
        const saved = readStockRequests(verified)
        if (!mounted.current || sequence !== generation) return
        setActor(verified)
        setRequests(saved)
        setError('')
      } catch {
        if (mounted.current && sequence === generation)
          setError(
            'Saved stock work could not be checked. Use the original account and keep this browser data.'
          )
      }
    }
    void read()
    window.addEventListener(stockJournalEvent, read)
    window.addEventListener('focus', read)
    window.addEventListener('storage', read)
    return () => {
      mounted.current = false
      generation++
      window.removeEventListener(stockJournalEvent, read)
      window.removeEventListener('focus', read)
      window.removeEventListener('storage', read)
    }
  }, [actorId])
  const visible = requests.filter(
    (command) => command.branchId !== excludeBranchId || command.deviceId !== excludeDeviceId
  )
  if (!visible.length && !error && !notice) return null
  return (
    <section className={styles.stock} aria-label="Recover saved stock work">
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {actor &&
        visible.map((command) => (
          <Request
            key={command.id}
            actorId={actor}
            command={command}
            disabled={!!disabled}
            onResolved={setNotice}
          />
        ))}
    </section>
  )
}
function Request({
  actorId,
  command,
  disabled,
  onResolved,
}: {
  actorId: string
  command: InventoryCommand
  disabled: boolean
  onResolved: (notice: string) => void
}) {
  const [busy, setBusy] = useState(false),
    [absent, setAbsent] = useState(false),
    [consent, setConsent] = useState(false),
    [error, setError] = useState('')
  const lock = useRef(false),
    mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  async function recover(mode: 'lookup' | 'cancel') {
    if (lock.current || disabled || (mode === 'cancel' && (!absent || !consent))) return
    lock.current = true
    setBusy(true)
    setError('')
    setAbsent(false)
    setConsent(false)
    try {
      if ((await currentActor()) !== actorId) throw new Error('actor_changed')
      const response = await fetch('/api/pos/inventory/recovery', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-POS-Actor': actorId },
        body: JSON.stringify({ mode, command }),
        signal: AbortSignal.timeout(20000),
      })
      const raw: unknown = await response.json()
      if (!response.ok) throw new Error('recovery_unavailable')
      const result = inventoryRecoverySchema.parse(raw)
      if (
        !inventoryResultMatches(result, command) ||
        (result.status === 'applied' && result.movement && result.movement.actorId !== actorId)
      )
        throw new Error('ack_mismatch')
      if (result.status === 'not_found') {
        if (mounted.current) setAbsent(true)
        return
      }
      await clearStockRequest(actorId, command)
      onResolved(
        result.status === 'applied'
          ? 'The original stock request was confirmed as saved. No duplicate movement was sent. Open Stock to check the latest balance.'
          : 'The server confirmed this stock request was cancelled. A delayed copy cannot apply it.'
      )
    } catch {
      if (mounted.current)
        setError(
          'This saved stock request could not be confirmed. Restore the original account and counter binding, then retry. No new stock movement was sent.'
        )
    } finally {
      lock.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <div className={styles.warning}>
      <strong>Saved stock work needs confirmation</strong>
      <p>
        Request {command.id.slice(0, 8)} ·{' '}
        {command.type === 'item.save' ? command.item.name : 'Stock movement'}
      </p>
      <p>
        Check the original request even if current branch access is unavailable. This does not
        create another movement.
      </p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <button disabled={disabled || busy} onClick={() => void recover('lookup')}>
        {busy ? 'Checking…' : 'Check saved stock work'}
      </button>
      {absent && (
        <>
          <p role="status">
            No saved result was found. Restore manager access to retry the exact request in Stock,
            or cancel it here if it has not been saved.
          </p>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={consent}
              disabled={disabled || busy}
              onChange={(event) => setConsent(event.target.checked)}
            />
            Cancel this request only if it has not already been saved.
          </label>
          <button disabled={disabled || busy || !consent} onClick={() => void recover('cancel')}>
            Cancel unsaved stock work
          </button>
          <p className={styles.help}>
            If it was already saved, its original result is recovered instead.
          </p>
        </>
      )}
    </div>
  )
}

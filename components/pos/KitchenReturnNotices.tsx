'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  kitchenReturnListSchema,
  kitchenReturnAckResultSchema,
  type KitchenReturnList,
} from '@/lib/pos/server/kitchen-returns'
type Props = {
  actorId: string
  branchId: string
  deviceId: string
  disabled?: boolean
  onAcknowledged?: () => void
}
export default function KitchenReturnNotices(props: Props) {
  return <Notices key={`${props.actorId}:${props.branchId}:${props.deviceId}`} {...props} />
}
function Notices({ actorId, branchId, deviceId, disabled = false, onAcknowledged }: Props) {
  const [page, setPage] = useState<KitchenReturnList | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const mounted = useRef(true),
    serial = useRef(0),
    inFlight = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      // Invalidate asynchronous results, rather than capturing a render-time sequence.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      serial.current++
      inFlight.current = false
    }
  }, [])
  const load = useCallback(
    async (cursor: KitchenReturnList['nextCursor'] = null) => {
      if (inFlight.current || !mounted.current) return
      inFlight.current = true
      const run = ++serial.current
      setBusy(true)
      setError('')
      try {
        const params = new URLSearchParams({ branchId, deviceId })
        if (cursor) {
          params.set('afterIssuedAt', cursor.issuedAt)
          params.set('afterId', cursor.id)
        }
        const response = await fetch('/api/pos/kitchen-returns?' + params, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.timeout(20000),
        })
        if (!response.ok) throw new Error()
        const data = kitchenReturnListSchema.parse(await response.json())
        if (data.branchId !== branchId) throw new Error()
        if (mounted.current && serial.current === run) setPage(data)
      } catch {
        if (mounted.current && serial.current === run) {
          setPage(null)
          setError(
            'Return notices could not be checked. Refresh before moving preparation forward.'
          )
        }
      } finally {
        if (serial.current === run) inFlight.current = false
        if (mounted.current && serial.current === run) setBusy(false)
      }
    },
    [branchId, deviceId]
  )
  useEffect(() => {
    void load()
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    const timer = window.setInterval(refreshVisible, 10000)
    document.addEventListener('visibilitychange', refreshVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshVisible)
    }
  }, [load])
  async function acknowledge(noticeId: string) {
    if (disabled || inFlight.current || !mounted.current) return
    inFlight.current = true
    const run = ++serial.current
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/pos/kitchen-returns', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'x-pos-actor': actorId },
        body: JSON.stringify({ branchId, deviceId, noticeId }),
        signal: AbortSignal.timeout(20000),
      })
      if (!response.ok) throw new Error()
      const data = kitchenReturnAckResultSchema.parse(await response.json())
      if (data.branchId !== branchId || data.noticeId !== noticeId) throw new Error()
      if (mounted.current && serial.current === run) {
        onAcknowledged?.()
        inFlight.current = false
        await load()
      }
    } catch {
      if (mounted.current && serial.current === run)
        setError(
          'Acknowledgement was not confirmed. Refresh the notices; retrying this same notice is safe.'
        )
    } finally {
      if (serial.current === run) inFlight.current = false
      if (mounted.current && serial.current === run) setBusy(false)
    }
  }
  return (
    <section aria-label="Kitchen return notices" className="lc-card">
      <h3>Return notices</h3>
      <p>
        Check the affected preparation before acknowledging. Returns do not automatically change
        stock or unfinished cooking.
      </p>
      <button disabled={busy} onClick={() => void load()}>
        Refresh return notices
      </button>
      {error && <p role="alert">{error}</p>}
      {page && <p>{page.pendingCount} awaiting acknowledgement</p>}
      {page?.notices.map((n) => (
        <article key={n.id} className="lc-warning">
          <h4>
            {n.creditNumber} · {n.invoiceNumber}
          </h4>
          <p>{n.reason}</p>
          <p>
            {n.fullyReturned
              ? 'All invoice quantities returned; the kitchen ticket is cancelled.'
              : 'Partial return — unaffected preparation remains unchanged.'}
          </p>
          <ul>
            {n.lines.map((l) => (
              <li key={l.originalLineNumber}>
                {l.name} (invoice line {l.originalLineNumber}): {l.quantityMilli / 1000} {l.unit}{' '}
                returned; {l.remainingQuantityMilli / 1000} {l.unit} remain on that invoice line.
              </li>
            ))}
          </ul>
          <button disabled={disabled || busy} onClick={() => void acknowledge(n.id)}>
            I checked this return with the kitchen
          </button>
        </article>
      ))}
      {page?.nextCursor && (
        <button disabled={busy} onClick={() => void load(page.nextCursor)}>
          More return notices
        </button>
      )}
    </section>
  )
}

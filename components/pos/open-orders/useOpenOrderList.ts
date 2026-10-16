'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { openOrderListSchema, type OpenOrderList } from '@/lib/pos/server/open-order-contracts'
import { openOrderCall } from './transport'
export type OpenOrderCursor = { createdAt: string; id: string } | null
export function useOpenOrderList(branchId: string, deviceId: string) {
  const [data, setData] = useState<OpenOrderList | null>(null),
    [fresh, setFresh] = useState(false)
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [cursor, setCursor] = useState<OpenOrderCursor>(null)
  const alive = useRef(false),
    reading = useRef(false),
    held = useRef(false),
    generation = useRef(0)
  const controller = useRef<AbortController | null>(null),
    currentCursor = useRef<OpenOrderCursor>(null)
  const load = useCallback(
    async (next: OpenOrderCursor = currentCursor.current) => {
      if (reading.current || held.current) return
      reading.current = true
      setLoading(true)
      const epoch = ++generation.current,
        abort = new AbortController()
      controller.current = abort
      const query = new URLSearchParams({ branchId, deviceId })
      if (next) {
        query.set('afterCreatedAt', next.createdAt)
        query.set('afterId', next.id)
      }
      try {
        const result = openOrderListSchema.parse(
          await openOrderCall(`/api/pos/open-orders?${query}`, undefined, abort.signal)
        )
        if (result.branchId !== branchId) throw new Error('scope')
        if (alive.current && epoch === generation.current) {
          setData(result)
          setFresh(true)
          setError('')
          setCursor(next)
          currentCursor.current = next
        }
      } catch {
        if (alive.current && epoch === generation.current) {
          setFresh(false)
          setError(
            'Saved orders could not refresh. Any orders and tables shown are the last confirmed view; actions are paused until a fresh update arrives.'
          )
        }
      } finally {
        if (epoch === generation.current) {
          reading.current = false
          if (alive.current) setLoading(false)
        }
      }
    },
    [branchId, deviceId]
  )
  useEffect(() => {
    alive.current = true
    void load(null)
    const refresh = () => {
      if (document.visibilityState === 'visible') void load()
    }
    const offline = () => {
      setFresh(false)
      setError('Connection lost. Reconnect and refresh saved orders before continuing.')
    }
    const timer = window.setInterval(refresh, 10000)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('online', refresh)
    window.addEventListener('offline', offline)
    return () => {
      alive.current = false
      // Numeric request generation invalidates asynchronous reads, not a DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++
      controller.current?.abort()
      reading.current = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('online', refresh)
      window.removeEventListener('offline', offline)
    }
  }, [load])
  function hold() {
    held.current = true
    generation.current++
    controller.current?.abort()
    reading.current = false
    setLoading(false)
    setFresh(false)
  }
  async function resume() {
    held.current = false
    if (alive.current) await load()
  }
  return { data, fresh, error, loading, cursor, load, hold, resume }
}

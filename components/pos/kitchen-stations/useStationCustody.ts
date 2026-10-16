'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { readPendingStationRequests, stationJournalEvent } from '@/lib/pos/kitchen-station-journal'
import {
  readPendingStationWorkRequests,
  stationWorkJournalEvent,
} from '@/lib/pos/kitchen-station-work-journal'

/** All of the actor's branches must be checked before changing account or counter. */
export function useStationCustody(actorId: string | undefined) {
  const current = useRef(actorId)
  current.current = actorId
  const generation = useRef(0)
  const invalidateReads = useCallback(() => {
    generation.current++
  }, [])
  const [state, setState] = useState({ actorId, ready: false, configuration: false, work: false })
  const check = useCallback(async () => {
    const sequence = ++generation.current
    const actor = actorId
    if (!actor) return false
    try {
      const [configuration, work] = await Promise.all([
        readPendingStationRequests(actor),
        readPendingStationWorkRequests(actor),
      ])
      if (current.current === actor && generation.current === sequence)
        setState({
          actorId: actor,
          ready: true,
          configuration: configuration.length > 0,
          work: work.length > 0,
        })
      return configuration.length > 0 || work.length > 0
    } catch (error) {
      if (current.current === actor && generation.current === sequence)
        setState((previous) => ({ ...previous, actorId: actor, ready: false }))
      throw error
    }
  }, [actorId])
  useEffect(() => {
    if (!actorId) return
    const refresh = () => {
      void check().catch(() => undefined)
    }
    refresh()
    const events = [stationJournalEvent, stationWorkJournalEvent]
    const channels: BroadcastChannel[] = []
    for (const event of events) {
      window.addEventListener(event, refresh)
      try {
        const channel = new BroadcastChannel(event)
        channel.onmessage = refresh
        channels.push(channel)
      } catch {
        /* Local events, focus and polling still re-read authoritative storage. */
      }
    }
    window.addEventListener('focus', refresh)
    const timer = window.setInterval(refresh, 5000)
    return () => {
      invalidateReads()
      for (const event of events) window.removeEventListener(event, refresh)
      channels.forEach((channel) => channel.close())
      window.removeEventListener('focus', refresh)
      window.clearInterval(timer)
    }
  }, [actorId, check, invalidateReads])
  const ready = state.actorId === actorId && state.ready
  return {
    ready,
    configuration: state.actorId === actorId && state.configuration,
    work: state.actorId === actorId && state.work,
    held: !!actorId && (!ready || state.configuration || state.work),
    check,
  }
}

'use client'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { readPendingStationRequests, stationJournalEvent } from '@/lib/pos/kitchen-station-journal'
import {
  readPendingStationWorkRequests,
  stationWorkJournalEvent,
} from '@/lib/pos/kitchen-station-work-journal'
import { KitchenStationPendingRecovery } from './KitchenStationManager'
import { StationWorkPendingRecovery } from './StationWorkBoard'

const actorSchema = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase())
const sessionSchema = z.object({ status: z.literal('authenticated'), userId: actorSchema }).strict()
type Props = {
  actorId?: string
  excludeConfigurationBranchId?: string
  excludeWorkBranchId?: string
  disabled?: boolean
}

/** Recovery does not depend on current branch membership, a catalogue, or a counter bootstrap. */
export default function PendingKitchenStationRecovery(props: Props) {
  return <Recovery key={props.actorId ?? 'session-discovery'} {...props} />
}
function Recovery({
  actorId,
  excludeConfigurationBranchId,
  excludeWorkBranchId,
  disabled = false,
}: Props) {
  const [state, setState] = useState<{
    actor: string
    configuration: string[]
    work: string[]
  } | null>(null)
  const [error, setError] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let alive = true,
      generation = 0
    const refresh = async () => {
      const version = ++generation
      // A session recheck retires old-account actions before waiting for identity.
      if (!actorId) setState(null)
      try {
        let actor: string
        if (actorId) actor = actorSchema.parse(actorId)
        else {
          const response = await fetch('/api/pos/session', {
            credentials: 'same-origin',
            cache: 'no-store',
            signal: AbortSignal.timeout(15000),
          })
          if (!response.ok) throw new Error('session_unavailable')
          actor = sessionSchema.parse(await response.json()).userId
        }
        if (!alive || version !== generation) return
        // Immediately unmount old-account recovery before reading the new account's journal.
        setState((old) => (old?.actor === actor ? old : null))
        const [configuration, work] = await Promise.all([
          readPendingStationRequests(actor),
          readPendingStationWorkRequests(actor),
        ])
        if (!alive || version !== generation) return
        if ([...configuration, ...work].some((record) => record.actorId !== actor))
          throw new Error('journal_scope')
        setState({
          actor,
          configuration: [...new Set(configuration.map((row) => row.command.branchId))].sort(),
          work: [...new Set(work.map((row) => row.command.branchId))].sort(),
        })
        setError(false)
      } catch {
        if (alive && version === generation) {
          setError(true)
          setState(null)
        }
      }
    }
    const check = () => {
      void refresh()
    }
    const visible = () => {
      if (!document.hidden) check()
    }
    const events = [stationJournalEvent, stationWorkJournalEvent]
    const channels: BroadcastChannel[] = []
    check()
    for (const event of events) {
      window.addEventListener(event, check)
      try {
        const channel = new BroadcastChannel(event)
        channel.onmessage = check
        channels.push(channel)
      } catch {
        /* Focus and same-tab events still recheck durable storage. */
      }
    }
    window.addEventListener('focus', check)
    document.addEventListener('visibilitychange', visible)
    return () => {
      alive = false
      generation++
      for (const event of events) window.removeEventListener(event, check)
      channels.forEach((channel) => channel.close())
      window.removeEventListener('focus', check)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [actorId, retry])
  if (error)
    return (
      <section aria-label="Saved kitchen requests">
        <p role="alert">
          Saved kitchen requests could not be checked. Use the original signed-in account and keep
          this browser’s data.
        </p>
        <button type="button" disabled={disabled} onClick={() => setRetry((value) => value + 1)}>
          Check saved kitchen requests
        </button>
      </section>
    )
  if (!state) return <p role="status">Checking saved kitchen requests…</p>
  return (
    <>
      {state.configuration
        .filter((branch) => branch !== excludeConfigurationBranchId)
        .map((branch) => (
          <KitchenStationPendingRecovery
            key={`configuration:${state.actor}:${branch}`}
            actorId={state.actor}
            branchId={branch}
            disabled={disabled}
          />
        ))}
      {state.work
        .filter((branch) => branch !== excludeWorkBranchId)
        .map((branch) => (
          <StationWorkPendingRecovery
            key={`work:${state.actor}:${branch}`}
            actorId={state.actor}
            branchId={branch}
            disabled={disabled}
          />
        ))}
    </>
  )
}

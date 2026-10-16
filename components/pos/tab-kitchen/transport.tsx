'use client'

import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import {
  tabKitchenCommandSchema,
  tabKitchenUpdateResultSchema,
  tabKitchenAckMatches,
  tabKitchenCancellationSchema,
  type TabKitchenCommand,
  type TabKitchenUpdateResult,
} from '@/lib/pos/server/tab-kitchen'
import {
  readPendingTabKitchenRequests,
  savePendingTabKitchenRequest,
  acknowledgeTabKitchenRequest,
  tabKitchenJournalEvent,
} from '@/lib/pos/tab-kitchen-journal'
import styles from './tab-kitchen.module.css'

export type TabKitchenResolution =
  | TabKitchenUpdateResult
  | { status: 'cancelled'; requestId: string; replayed: boolean }
export type TabKitchenScope = {
  actorId: string
  branchId: string
  disabled: boolean
  onPendingChange?: (pending: boolean) => void
  onBusyChange?: (busy: boolean) => void
  onResolved?: (command: TabKitchenCommand, result: TabKitchenResolution) => void | Promise<void>
}
const requestLabel = (command: TabKitchenCommand) =>
  ({
    dispatch: 'Send order changes to kitchen',
    stage: 'Move preparation quantities',
    acknowledge: 'Acknowledge kitchen notices',
  })[command.type]

class TabKitchenError extends Error {
  constructor(public code: string) {
    super(code)
  }
}
export async function tabKitchenCall(url: string, body?: TabKitchenCommand, signal?: AbortSignal) {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
      : AbortSignal.timeout(20000),
  })
  const data: unknown = await response.json()
  if (!response.ok)
    throw new TabKitchenError(
      data && typeof data === 'object' && 'code' in data ? String(data.code) : 'unavailable'
    )
  return data
}
export function useTabKitchenCommands({
  actorId,
  branchId,
  disabled,
  onPendingChange,
  onBusyChange,
  onResolved,
}: TabKitchenScope) {
  const [pending, setPending] = useState<TabKitchenCommand | null>(null)
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false)
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const alive = useRef(false),
    locked = useRef(false),
    callback = useRef(onPendingChange),
    busyCallback = useRef(onBusyChange),
    resolvedCallback = useRef(onResolved)
  callback.current = onPendingChange
  busyCallback.current = onBusyChange
  resolvedCallback.current = onResolved
  useEffect(() => {
    alive.current = true
    let active = true,
      checking = false
    async function check() {
      if (checking || locked.current) return
      checking = true
      try {
        const records = await readPendingTabKitchenRequests(actorId)
        if (!active || locked.current) return
        const saved =
          records.find((record) => record.command.branchId === branchId)?.command ?? null
        setPending(saved)
        setReady(true)
        callback.current?.(!!saved)
      } catch {
        if (active) {
          setReady(false)
          callback.current?.(true)
          setError(
            'Saved kitchen changes could not be read. Editing is paused. Keep browser data intact and ask your administrator for help.'
          )
        }
      } finally {
        checking = false
      }
    }
    void check()
    const refresh = () => {
      void check()
    }
    window.addEventListener(tabKitchenJournalEvent, refresh)
    window.addEventListener('focus', refresh)
    let channel: BroadcastChannel | null = null
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(tabKitchenJournalEvent)
        channel.onmessage = refresh
      }
    } catch {
      /* Atomic storage still prevents overwrite. */
    }
    return () => {
      active = false
      alive.current = false
      window.removeEventListener(tabKitchenJournalEvent, refresh)
      window.removeEventListener('focus', refresh)
      channel?.close()
    }
  }, [actorId, branchId])
  useEffect(() => {
    if (!pending) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [pending])
  async function execute(
    command: TabKitchenCommand,
    recovery = false,
    existing = false
  ): Promise<TabKitchenUpdateResult | null> {
    if (disabled || locked.current || !ready) return null
    command = tabKitchenCommandSchema.parse(command)
    locked.current = true
    busyCallback.current?.(true)
    setBusy(true)
    setError('')
    setNotice('')
    let persisted = existing
    try {
      if (!existing) {
        await savePendingTabKitchenRequest({ actorId, command })
        persisted = true
      }
      if (alive.current) setPending(command)
      callback.current?.(true)
      const raw = await tabKitchenCall(
        recovery ? '/api/pos/tab-kitchen/recovery' : '/api/pos/tab-kitchen',
        command
      )
      const cancellation = tabKitchenCancellationSchema.safeParse(raw)
      const cancelled =
        recovery && cancellation.success && cancellation.data.requestId === command.id
      let result: TabKitchenUpdateResult | null = null
      if (!cancelled) {
        result = tabKitchenUpdateResultSchema.parse(raw)
        if (!tabKitchenAckMatches(command, result)) throw new Error('ack_mismatch')
      }
      await resolvedCallback.current?.(
        command,
        result ??
          (cancellation.success
            ? cancellation.data
            : (() => {
                throw new Error('missing_confirmation')
              })())
      )
      await acknowledgeTabKitchenRequest(actorId, branchId, command.id)
      callback.current?.(false)
      if (alive.current) {
        setPending(null)
        setNotice(
          cancelled
            ? 'This unsaved change was permanently cancelled. Refresh and check the kitchen order before another action.'
            : 'Saved change confirmed.'
        )
      }
      return result
    } catch (cause) {
      if (!alive.current) return null
      if (!persisted) {
        try {
          const saved =
            (await readPendingTabKitchenRequests(actorId)).find(
              (record) => record.command.branchId === branchId
            )?.command ?? null
          setPending(saved)
          callback.current?.(!!saved)
          if (!saved) setReady(false)
        } catch {
          setReady(false)
        }
        setError(
          'The change could not be stored safely, so no new request was sent. Recover any saved change before continuing.'
        )
      } else {
        setError(
          cause instanceof TabKitchenError &&
            cause.code === 'kitchen_return_acknowledgement_required'
            ? 'Check and acknowledge the return notice before changing preparation. Keep this saved change for recovery.'
            : cause instanceof TabKitchenError && /conflict|revision/.test(cause.code)
              ? 'Another operator may have changed this kitchen order. Check the saved change below before trying a new action.'
              : 'The kitchen change is not confirmed. Keep this request and check it below; do not repeat the action as a new change.'
        )
      }
      return null
    } finally {
      locked.current = false
      busyCallback.current?.(false)
      if (alive.current) setBusy(false)
    }
  }
  return { pending, ready, busy, error, notice, execute }
}
export type TabKitchenCommandState = ReturnType<typeof useTabKitchenCommands>
export function TabKitchenPendingPanel({
  state,
  disabled,
  run,
}: {
  state: TabKitchenCommandState
  disabled: boolean
  run: (recover: boolean) => void
}) {
  const [cancelAllowed, setCancelAllowed] = useState(false)
  return (
    <>
      {state.error && (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      )}
      {state.notice && (
        <p className={styles.notice} role="status">
          {state.notice}
        </p>
      )}
      {state.pending && (
        <section className={styles.pending} aria-label="Saved kitchen change">
          <h3>A kitchen change needs confirmation</h3>
          <p>
            Requested change: <strong>{requestLabel(state.pending)}</strong>. The saved request is
            kept until the server confirms its result.
          </p>
          <p className={styles.reference}>Request {state.pending.id}</p>
          <button disabled={disabled || state.busy} onClick={() => run(false)}>
            {state.busy ? 'Checking…' : 'Retry saved kitchen dispatch change'}
          </button>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={cancelAllowed}
              onChange={(event) => setCancelAllowed(event.target.checked)}
              disabled={state.busy}
            />
            Cancel this change permanently if the server confirms it was never saved.
          </label>
          <button disabled={disabled || state.busy || !cancelAllowed} onClick={() => run(true)}>
            Check or cancel saved change
          </button>
          <p className={styles.help}>
            This cancels only a change that was never saved. It does not undo kitchen preparation,
            void an order or refund a payment.
          </p>
        </section>
      )}
    </>
  )
}
export function TabKitchenPendingRecovery(props: {
  actorId?: string
  branchId?: string
  excludeBranchId?: string
  disabled?: boolean
  onPendingChange?: (pending: boolean) => void
  onBusyChange?: (busy: boolean) => void
  onResolved?: (command: TabKitchenCommand, result: TabKitchenResolution) => void | Promise<void>
}) {
  const [actor, setActor] = useState(props.actorId ?? '')
  const [branches, setBranches] = useState<string[]>([]),
    [error, setError] = useState('')
  const callback = useRef(props.onPendingChange)
  callback.current = props.onPendingChange
  useEffect(() => {
    let alive = true,
      reading = false
    async function discover() {
      if (reading) return
      reading = true
      try {
        const actorId =
          props.actorId ??
          z
            .object({ status: z.literal('authenticated'), userId: z.string().uuid() })
            .strict()
            .parse(await tabKitchenCall('/api/pos/session')).userId
        const records = await readPendingTabKitchenRequests(actorId)
        if (!alive) return
        setActor(actorId)
        setBranches(
          records
            .filter(
              (record) =>
                (!props.branchId || record.command.branchId === props.branchId) &&
                record.command.branchId !== props.excludeBranchId
            )
            .map((record) => record.command.branchId)
        )
        setError('')
        callback.current?.(records.length > 0)
      } catch {
        if (alive) {
          setError(
            'Kitchen dispatch recovery could not be checked. Sign in with the original staff account and keep browser data intact.'
          )
          callback.current?.(true)
        }
      } finally {
        reading = false
      }
    }
    void discover()
    const change = () => {
      void discover()
    }
    window.addEventListener(tabKitchenJournalEvent, change)
    window.addEventListener('focus', change)
    let channel: BroadcastChannel | null = null
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(tabKitchenJournalEvent)
        channel.onmessage = change
      }
    } catch {
      /* Focus checks remain available. */
    }
    return () => {
      alive = false
      window.removeEventListener(tabKitchenJournalEvent, change)
      window.removeEventListener('focus', change)
      channel?.close()
    }
  }, [props.actorId, props.branchId, props.excludeBranchId])
  return (
    <>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {branches.map((branchId) => (
        <Recovery
          key={`${actor}:${branchId}`}
          actorId={actor}
          branchId={branchId}
          disabled={props.disabled ?? false}
          onBusyChange={props.onBusyChange}
          onResolved={props.onResolved}
        />
      ))}
    </>
  )
}
function Recovery(props: TabKitchenScope) {
  const state = useTabKitchenCommands(props)
  return (
    <section className={styles.recovery} aria-label="Saved kitchen dispatch request recovery">
      <TabKitchenPendingPanel
        key={state.pending?.id ?? 'none'}
        state={state}
        disabled={props.disabled}
        run={(recover) => {
          if (state.pending) void state.execute(state.pending, recover, true)
        }}
      />
    </section>
  )
}

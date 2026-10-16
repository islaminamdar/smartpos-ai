import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getNativeShiftCloseState,
  checkNativeShiftClose,
  closeNativeShift,
  retryNativeShiftClose,
  nativeOfflineErrorCode,
  subscribeNativeCheckoutLock,
} from './native'

type State = Awaited<ReturnType<typeof getNativeShiftCloseState>>
type Props = {
  available: boolean
  ready: boolean
  revision: number
  actorId: string | null
  actionsBlocked: boolean
  operationLock: { current: boolean }
  onBusyChange: (busy: boolean) => void
  onPendingChange: (pending: boolean) => void
  onCheckedVersion: (revision: number) => void
  onChanged: () => void
}
const messages: Record<string, string> = {
  offline_allocation_active: 'Finish the current invoice allocation before closing this drawer.',
  payment_reconciliation_required:
    'A saved payment needs checking. Review that original payment in Counter; do not collect again.',
  offline_upload_required:
    'Use Upload saved records to confirm outstanding receipts and finished allocations before closing.',
  shift_close_unavailable:
    'This drawer cannot be closed in its current state. Keep saved records and check with your manager.',
  shift_already_closed:
    'The original shift is already closed. Check its saved close result before continuing setup.',
  offline_preparation_uncertain:
    'A saved preparation request needs confirmation. Resolve that exact request before closing.',
  native_shift_close_uncertain:
    'Closing was not confirmed. Keep the saved count and check the original close request before retrying.',
  native_shift_close_pending:
    'The original close request is still pending. Check it before retrying; do not enter another count.',
  native_session_expired: 'Sign in with the original staff account to check this drawer.',
  offline_context_changed:
    'The original shift or staff scope no longer matches. Keep saved records and contact your manager.',
  native_storage_unavailable:
    'The saved drawer record could not be read. Keep this app’s data and contact your manager or support.',
  pin_unlock_required:
    'Check this drawer through the Android dialog to unlock its original cash records.',
  offline_not_configured:
    'Drawer closing is not configured in this app build. Keep saved records and ask for the approved update.',
  shift_close_cancelled:
    'Android confirmation cancelled. Check the original drawer before continuing.',
  native_pin_cancelled:
    'Android confirmation cancelled. Check the original drawer before continuing.',
  native_network_unavailable:
    'Connect to the internet, then check the original close request. Do not replace its saved count.',
}
const message = (error: unknown) =>
  messages[nativeOfflineErrorCode(error)] ??
  'Drawer closing could not be verified. Keep the original records and check again; do not start a replacement close request.'
const money = (fils: number) => `AED ${(fils / 100).toFixed(2)}`
export function countedCashToFils(value: string): number | null {
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(value.trim())) return null
  const [whole, fraction = ''] = value.trim().split('.')
  const fils = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(fils) && fils >= 0 && fils <= 100_000_000 ? fils : null
}
export default function NativeShiftClose({
  available,
  ready,
  revision,
  actorId,
  actionsBlocked,
  operationLock,
  onBusyChange,
  onPendingChange,
  onCheckedVersion,
  onChanged,
}: Props) {
  const [state, setState] = useState<State | null>(null),
    [fresh, setFresh] = useState(false)
  const [checked, setChecked] = useState(-1),
    [onlineChecked, setOnlineChecked] = useState(false)
  const [busy, setBusy] = useState<'local' | 'check' | 'close' | 'retry' | null>(null)
  const [listening, setListening] = useState(false),
    [error, setError] = useState('')
  const [count, setCount] = useState(''),
    [consent, setConsent] = useState<string | null>(null)
  const [original, setOriginal] = useState<{ shiftId: string; commandId: string | null } | null>(
    null
  )
  const [readActor, setReadActor] = useState<string | null>(null)
  const mounted = useRef(false),
    active = useRef(false),
    epoch = useRef(0),
    notified = useRef<string | null>(null)
  const scope = `${revision}:${actorId ?? ''}`,
    currentScope = useRef(scope)
  currentScope.current = scope
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!available) return
    let disposed = false,
      remove: (() => Promise<void>) | undefined
    const invalidate = () => {
      epoch.current++
      setState((previous) =>
        previous
          ? { ...previous, countedCashFils: null, result: null, canClose: false, canRetry: false }
          : null
      )
      setFresh(false)
      setOnlineChecked(false)
      setCount('')
      setConsent(null)
      onPendingChange(true)
    }
    const visibility = () => {
      if (document.visibilityState === 'hidden') invalidate()
    }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', invalidate)
    void subscribeNativeCheckoutLock(invalidate)
      .then((handle) => {
        if (disposed) void handle.remove()
        else {
          remove = () => handle.remove()
          setListening(true)
        }
      })
      .catch(() => {
        if (!disposed) {
          invalidate()
          setError(
            'Device lock monitoring is unavailable. Keep saved records and contact your manager.'
          )
        }
      })
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', invalidate)
      if (remove) void remove()
    }
  }, [available, onPendingChange])
  const current = (token: number, selectedScope: string) =>
    mounted.current && token === epoch.current && selectedScope === currentScope.current
  const start = (kind: NonNullable<typeof busy>) => {
    if (!available || !ready || !listening || operationLock.current || active.current) return false
    operationLock.current = true
    active.current = true
    setBusy(kind)
    onBusyChange(true)
    setFresh(false)
    setOnlineChecked(false)
    setConsent(null)
    setError('')
    return true
  }
  const finish = () => {
    operationLock.current = false
    active.current = false
    if (mounted.current) {
      setBusy(null)
      onBusyChange(false)
    }
  }
  function apply(
    next: State,
    token: number,
    selectedScope: string,
    expected: { shiftId: string; commandId: string | null; countedCashFils?: number } | null,
    online: boolean,
    allowAbsent = false
  ) {
    if (!current(token, selectedScope)) return false
    if (
      expected &&
      (next.shiftId !== expected.shiftId ||
        (expected.commandId && next.commandId !== expected.commandId) ||
        (expected.countedCashFils !== undefined &&
          next.countedCashFils !== null &&
          next.countedCashFils !== expected.countedCashFils))
    ) {
      setError(message(new Error('offline_context_changed')))
      onPendingChange(true)
      return false
    }
    setState(next)
    setFresh(true)
    setChecked(revision)
    setReadActor(actorId)
    setOnlineChecked(online)
    setConsent(null)
    const pending =
      next.status === 'pending' || (next.commandId !== null && next.status !== 'closed')
    const confirmedAbsent =
      allowAbsent &&
      online &&
      expected?.commandId === null &&
      next.status === 'ready' &&
      next.canClose &&
      next.commandId === null &&
      next.shiftId === expected.shiftId
    onPendingChange(pending || (!!expected && next.status !== 'closed' && !confirmedAbsent))
    if (confirmedAbsent) {
      setOriginal(null)
      setCount('')
      setError('')
    }
    if (pending && next.shiftId) setOriginal({ shiftId: next.shiftId, commandId: next.commandId })
    if (next.status === 'closed') {
      setOriginal(null)
      setCount('')
      setError('')
      return true
    }
    return false
  }
  const localRead = useCallback(async () => {
    if (!available || !ready || !listening || operationLock.current || active.current) return
    operationLock.current = true
    active.current = true
    setBusy('local')
    onBusyChange(true)
    setFresh(false)
    setOnlineChecked(false)
    setConsent(null)
    const token = epoch.current,
      selectedScope = scope
    try {
      const next = await getNativeShiftCloseState()
      apply(next, token, selectedScope, original, false)
    } catch (failure) {
      if (current(token, selectedScope)) {
        setError(message(failure))
        onPendingChange(true)
      }
    } finally {
      finish()
      if (current(token, selectedScope)) {
        setChecked(revision)
        onCheckedVersion(revision)
      }
    }
    // Reads use the render's exact actor/revision and never retry a financial write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    available,
    ready,
    listening,
    revision,
    actorId,
    operationLock,
    onBusyChange,
    onPendingChange,
    onCheckedVersion,
  ])
  useEffect(() => {
    if (ready && listening && checked !== revision) void localRead()
  }, [ready, listening, checked, revision, localRead])
  const amount = countedCashToFils(count)
  const currentDetails = fresh && checked === revision && readActor === actorId
  const known =
    state?.reasonCode === null || !!(state?.reasonCode && Object.hasOwn(messages, state.reasonCode))
  const mayClose =
    currentDetails &&
    onlineChecked &&
    !!actorId &&
    !actionsBlocked &&
    !busy &&
    known &&
    state?.status === 'ready' &&
    state.canClose &&
    !original &&
    amount !== null
  const mayRetry =
    currentDetails &&
    onlineChecked &&
    !!actorId &&
    !actionsBlocked &&
    !busy &&
    known &&
    state?.status === 'pending' &&
    state.canRetry &&
    !!state.commandId
  const consentKey =
    state?.status === 'pending'
      ? `${scope}:${state.shiftId}:${state.commandId}:${state.countedCashFils}`
      : `${scope}:${state?.shiftId}:${amount}`
  async function run(kind: 'check' | 'close' | 'retry') {
    if (
      kind === 'close' &&
      (!mayClose || consent !== consentKey || !state?.shiftId || amount === null)
    )
      return
    if (kind === 'retry' && (!mayRetry || consent !== consentKey || !state?.commandId)) return
    const expected =
      kind === 'close'
        ? { shiftId: state!.shiftId!, commandId: null, countedCashFils: amount! }
        : original
    if (!start(kind)) return
    if (kind !== 'check') {
      onPendingChange(true)
      setOriginal(expected)
      setCount('')
    }
    const token = epoch.current,
      selectedScope = scope
    let completed = false,
      commandId: string | null = null
    try {
      const next = await (kind === 'check'
        ? checkNativeShiftClose()
        : kind === 'close'
          ? closeNativeShift(state!.shiftId!, amount!)
          : retryNativeShiftClose(state!.commandId!))
      completed = apply(next, token, selectedScope, expected, true, kind === 'check')
      commandId = next.commandId
    } catch (failure) {
      if (current(token, selectedScope)) setError(message(failure))
      try {
        const next = await getNativeShiftCloseState()
        completed = apply(next, token, selectedScope, expected, false)
        commandId = next.commandId
      } catch {
        if (current(token, selectedScope)) {
          setFresh(false)
          onPendingChange(true)
        }
      }
    } finally {
      finish()
      if (current(token, selectedScope)) {
        onCheckedVersion(revision)
        if (completed && commandId && notified.current !== commandId) {
          notified.current = commandId
          onChanged()
        }
      }
    }
  }
  const visible =
    actorId !== null && readActor === actorId
      ? state
      : state
        ? { ...state, countedCashFils: null, result: null }
        : null
  return (
    <section className="bundle-recovery" aria-labelledby="shift-close-heading">
      <h3 id="shift-close-heading">Close this cash drawer</h3>
      <p>
        Count the actual cash in this Android counter’s drawer. Closing needs internet and
        confirmation in the Android dialog. It does not open another shift or prepare an allocation.
      </p>
      {!available ? (
        <p className="help">Open the installed Android app to check its original drawer.</p>
      ) : (
        <>
          {busy && (
            <p role="status" className="access-note">
              {busy === 'local'
                ? 'Reading saved drawer status…'
                : busy === 'check'
                  ? 'Checking the original drawer through the Android dialog…'
                  : 'Saving the original drawer close request…'}
            </p>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {visible && (
            <div className="bundle-recovery-state">
              <strong>
                {visible.status === 'closed'
                  ? 'Original drawer closed'
                  : visible.status === 'pending'
                    ? 'Original close request needs confirmation'
                    : visible.status === 'ready'
                      ? 'Drawer checked for closing'
                      : visible.status === 'blocked'
                        ? 'Drawer closing is blocked'
                        : visible.status === 'needs_check'
                          ? 'Check this drawer before counting'
                          : 'No drawer is available to close'}
              </strong>
              {visible.reasonCode && <p>{message(new Error(visible.reasonCode))}</p>}
              {visible.shiftId && (
                <details>
                  <summary>Drawer references</summary>
                  <p className="help">
                    Original shift <span className="reference">{visible.shiftId}</span>
                  </p>
                  {visible.commandId && (
                    <p className="help">
                      Close request <span className="reference">{visible.commandId}</span>
                    </p>
                  )}
                </details>
              )}
              {visible.status === 'pending' && (
                <>
                  <p>
                    {visible.countedCashFils === null
                      ? 'Check through the Android dialog to view the original saved cash count.'
                      : `Saved counted cash: ${money(visible.countedCashFils)}. This amount cannot be edited while confirmation is pending.`}
                  </p>
                  <p>
                    Check the original close request before retrying. Do not create another request
                    or enter a replacement cash count.
                  </p>
                </>
              )}
              {visible.result && (
                <>
                  <dl className="record-values">
                    <div>
                      <dt>Counted cash</dt>
                      <dd>{money(visible.result.countedCashFils)}</dd>
                    </div>
                    <div>
                      <dt>Expected cash confirmed by server</dt>
                      <dd>{money(visible.result.expectedCashFils)}</dd>
                    </div>
                    <div>
                      <dt>Cash difference confirmed by server</dt>
                      <dd>{money(visible.result.cashDifferenceFils)}</dd>
                    </div>
                  </dl>
                  <p className="help">
                    Closed{' '}
                    {new Intl.DateTimeFormat('en-GB', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                      timeZone: 'Asia/Dubai',
                    }).format(new Date(visible.result.closedAt))}{' '}
                    Dubai time.
                  </p>
                  <p>
                    Keep all saved bills and payment records. Check Next invoice allocation for a
                    finished allocation, or Prepare offline access for the next opening-cash step.
                    No new shift was opened here.
                  </p>
                </>
              )}
              {visible.status === 'closed' && !visible.result && (
                <p>Check through the Android dialog to view the original confirmed cash totals.</p>
              )}
              {(!fresh || checked !== revision) && (
                <p className="help">
                  Saved status. Check the drawer again before taking another action.
                </p>
              )}
            </div>
          )}
          {actionsBlocked && (
            <p className="access-note">
              A payment or setup request needs checking. A new close is paused. Resolve the original
              request in its recovery panel before closing this drawer.
            </p>
          )}
          {currentDetails && onlineChecked && state?.status === 'ready' && !original && (
            <div className="bundle-recovery-confirm offline-shift">
              <label>
                Actual cash counted (AED)
                <input
                  inputMode="decimal"
                  type="text"
                  value={count}
                  maxLength={14}
                  disabled={!!busy || actionsBlocked}
                  onChange={(event) => {
                    setCount(event.target.value)
                    setConsent(null)
                  }}
                  aria-describedby="close-count-help"
                />
              </label>
              <p id="close-count-help" className="help">
                Enter the complete cash count with no more than two decimal places. The amount is
                never rounded.
              </p>
              {count && amount === null && (
                <p role="alert" className="error">
                  Enter a valid AED amount with no more than two decimal places.
                </p>
              )}
              <label className="cash-confirm">
                <input
                  type="checkbox"
                  checked={consent === consentKey}
                  disabled={!mayClose}
                  onChange={(event) => setConsent(event.target.checked ? consentKey : null)}
                />
                <span>
                  {amount === null
                    ? 'I will confirm the exact cash count before closing this original shift.'
                    : `I confirm closing this original shift with ${money(amount)} counted.`}{' '}
                  Keep all records; do not open another shift.
                </span>
              </label>
              <button
                className="primary"
                disabled={!mayClose || consent !== consentKey}
                onClick={() => void run('close')}
              >
                Confirm cash count and close drawer
              </button>
            </div>
          )}
          {state?.status === 'pending' &&
            currentDetails &&
            onlineChecked &&
            state.countedCashFils !== null && (
              <div className="bundle-recovery-confirm">
                <label className="cash-confirm">
                  <input
                    type="checkbox"
                    checked={consent === consentKey}
                    disabled={!mayRetry}
                    onChange={(event) => setConsent(event.target.checked ? consentKey : null)}
                  />
                  <span>
                    I confirm retrying only the original close request with its saved count of{' '}
                    {money(state.countedCashFils)}.
                  </span>
                </label>
                <button
                  className="secondary"
                  disabled={!mayRetry || consent !== consentKey}
                  onClick={() => void run('retry')}
                >
                  Retry original close request
                </button>
              </div>
            )}
          <button
            className="secondary access-refresh"
            disabled={!ready || !listening || !!busy}
            onClick={() => void run('check')}
          >
            Check drawer for closing
          </button>
          <p className="help">
            A check reads current server status and may ask for the original PIN or confirmation in
            Android. It does not submit a new close or change its saved count.
          </p>
        </>
      )}
    </section>
  )
}

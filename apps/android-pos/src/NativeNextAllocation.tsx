import { useEffect, useRef, useState } from 'react'
import {
  getNativeNextAllocationState,
  continueNativeAfterAllocation,
  nativeOfflineErrorCode,
  subscribeNativeCheckoutLock,
} from './native'

type NextState = Awaited<ReturnType<typeof getNativeNextAllocationState>>
type Props = {
  available: boolean
  ready: boolean
  revision: number
  actorId: string | null
  actionsBlocked: boolean
  operationLock: { current: boolean }
  onBusyChange: (busy: boolean) => void
  onPendingChange: (pending: boolean) => void
  onChanged: () => void
}
const messages: Record<string, string> = {
  offline_allocation_active:
    'The current invoice allocation is still active. Finish it and confirm its saved records before continuing setup.',
  offline_seal_confirmation_required:
    'The finished allocation still needs server confirmation. Use Upload saved records, then check next setup again.',
  offline_upload_required:
    'Saved records still need uploading. Use Upload saved records before continuing setup.',
  payment_reconciliation_required:
    'Check the saved payment in Counter. Setup cannot continue while that payment needs attention.',
  previous_authority_unresolved:
    'An earlier allocation needs checking. Keep this app’s data and contact your manager or support.',
  offline_continuation_uncertain:
    'The setup handoff was not confirmed. Check its saved status before retrying the same allocation.',
  offline_context_changed:
    'The original staff, counter, shift or allocation no longer matches. Keep saved records and check access with your manager.',
  pin_unlock_required:
    'Use the original staff account and the Android PIN dialog to continue setup.',
  native_session_expired: 'Sign in with the original staff account before continuing setup.',
  native_storage_unavailable:
    'The saved setup record could not be read. Keep this app’s data and contact your manager or support.',
  offline_not_configured:
    'This app build is not configured for the next setup step. Keep saved records and ask your manager for the approved update.',
  native_network_unavailable:
    'Connect to the internet, then check the original setup status before retrying.',
  native_pin_cancelled:
    'Android PIN dialog cancelled. Check the saved setup status before continuing.',
}
const describeError = (error: unknown) =>
  messages[nativeOfflineErrorCode(error)] ??
  'Next setup could not be verified. Keep saved records and check the original allocation before continuing.'

export default function NativeNextAllocation({
  available,
  ready,
  revision,
  actorId,
  actionsBlocked,
  operationLock,
  onBusyChange,
  onPendingChange,
  onChanged,
}: Props) {
  const [state, setState] = useState<NextState | null>(null)
  const [fresh, setFresh] = useState(false)
  const [checkedRevision, setCheckedRevision] = useState(-1)
  const [checkedScope, setCheckedScope] = useState<string | null>(null)
  const [checkedActor, setCheckedActor] = useState<string | null>(null)
  const [busy, setBusy] = useState<'check' | 'continue' | null>(null)
  const [consent, setConsent] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [listening, setListening] = useState(false)
  const [original, setOriginal] = useState<{ authorityId: string; shiftId: string } | null>(null)
  const mounted = useRef(false)
  const active = useRef(false)
  const epoch = useRef(0)
  const scope = `${revision}:${actorId ?? ''}`
  const currentScope = useRef(scope)
  currentScope.current = scope
  const notified = useRef<string | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!available) return
    let disposed = false
    let remove: (() => Promise<void>) | undefined
    const invalidate = () => {
      epoch.current++
      setFresh(false)
      setState(null)
      setConsent(null)
      setError('Setup is locked. Check next setup again before continuing.')
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
          setListening(false)
          setError(
            'Device lock monitoring is unavailable. Keep saved records and contact your manager or support.'
          )
        }
      })
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', invalidate)
      if (remove) void remove()
    }
  }, [available])
  const current = (token: number, selectedScope: string) =>
    mounted.current && token === epoch.current && selectedScope === currentScope.current
  function start(kind: 'check' | 'continue') {
    if (!available || !ready || !listening || operationLock.current || active.current) return false
    operationLock.current = true
    active.current = true
    setBusy(kind)
    onBusyChange(true)
    setFresh(false)
    setConsent(null)
    setError('')
    return true
  }
  function finish() {
    operationLock.current = false
    active.current = false
    if (mounted.current) {
      setBusy(null)
      onBusyChange(false)
    }
  }
  function apply(
    next: NextState,
    token: number,
    selectedScope: string,
    expected: { authorityId: string; shiftId: string } | null
  ) {
    if (!current(token, selectedScope)) return false
    if (
      expected &&
      (next.previousAuthorityId !== expected.authorityId || next.shiftId !== expected.shiftId)
    ) {
      setFresh(false)
      setError(describeError(new Error('offline_context_changed')))
      return false
    }
    setState(next)
    setCheckedRevision(revision)
    setCheckedScope(selectedScope)
    setCheckedActor(actorId)
    setFresh(true)
    setConsent(null)
    if (next.status === 'completed') {
      setOriginal(null)
      onPendingChange(false)
      setError('')
      return true
    }
    if (next.status === 'pending' && next.canContinue) onPendingChange(true)
    return false
  }
  function changed(completed: boolean, authorityId: string | null) {
    if (completed && authorityId && notified.current !== authorityId) {
      notified.current = authorityId
      onChanged()
    }
  }
  async function check() {
    if (!start('check')) return
    const token = epoch.current,
      selectedScope = scope
    let completed = false,
      authorityId: string | null = null
    try {
      const next = await getNativeNextAllocationState()
      completed = apply(next, token, selectedScope, original)
      authorityId = next.previousAuthorityId
    } catch (failure) {
      if (current(token, selectedScope)) setError(describeError(failure))
    } finally {
      finish()
      if (current(token, selectedScope)) changed(completed, authorityId)
    }
  }
  const key =
    state?.previousAuthorityId && state.shiftId && actorId
      ? `${scope}:${state.previousAuthorityId}:${state.shiftId}`
      : null
  const mayContinue =
    available &&
    ready &&
    listening &&
    fresh &&
    checkedRevision === revision &&
    checkedScope === scope &&
    !busy &&
    !actionsBlocked &&
    !!key &&
    !!state &&
    (state.reasonCode === null || Object.hasOwn(messages, state.reasonCode)) &&
    ['ready', 'pending'].includes(state.status) &&
    state.canContinue &&
    (!original ||
      (original.authorityId === state.previousAuthorityId && original.shiftId === state.shiftId))
  const mayCheckShift =
    available &&
    ready &&
    listening &&
    fresh &&
    checkedRevision === revision &&
    checkedScope === scope &&
    !busy &&
    !actionsBlocked &&
    !!key &&
    state?.status === 'completed' &&
    state.reasonCode === null &&
    state.shiftId !== null &&
    state.nextShiftId === state.shiftId
  async function proceed(checkShift = false) {
    const consentKey = checkShift ? `${key}:shift_status` : key
    if (
      !(checkShift ? mayCheckShift : mayContinue) ||
      !key ||
      consent !== consentKey ||
      !state?.previousAuthorityId ||
      !state.shiftId
    )
      return
    const expected = { authorityId: state.previousAuthorityId, shiftId: state.shiftId }
    if (!start('continue')) return
    notified.current = null
    setOriginal(expected)
    onPendingChange(true)
    const token = epoch.current,
      selectedScope = scope
    let completed = false
    try {
      const next = await continueNativeAfterAllocation(expected.authorityId)
      completed = apply(next, token, selectedScope, expected)
    } catch (failure) {
      if (current(token, selectedScope)) setError(describeError(failure))
      // A local read discovers the durable outcome; it never starts a replacement handoff.
      try {
        const next = await getNativeNextAllocationState()
        completed = apply(next, token, selectedScope, expected)
        if (
          checkShift &&
          completed &&
          next.nextShiftId === next.shiftId &&
          current(token, selectedScope)
        )
          setError(
            'The online shift check was not confirmed. The last saved status is shown; check the original shift again before continuing.'
          )
      } catch {
        if (current(token, selectedScope)) setFresh(false)
      }
    } finally {
      finish()
      if (current(token, selectedScope)) changed(completed, expected.authorityId)
    }
  }
  const visible =
    (checkedRevision === revision && checkedScope === scope) ||
    (state?.status === 'completed' && actorId !== null && checkedActor === actorId)
      ? state
      : null
  return (
    <section className="bundle-recovery" aria-labelledby="next-allocation-heading">
      <h3 id="next-allocation-heading">Next invoice allocation</h3>
      <p>
        Continue setup after the original allocation is finished and its saved records are
        confirmed. Previous bills and payment records stay on this device.
      </p>
      <p className="help">
        Closing this Android cash drawer is not available in this version. Continuing setup can
        reuse the same open shift; starting a new shift requires the original drawer to be closed.
        This handoff does not prepare a new allocation. New sales remain paused.
      </p>
      {!available ? (
        <p className="help">Open the installed Android app to check its next setup step.</p>
      ) : (
        <>
          {busy && (
            <p className="access-note" role="status">
              {busy === 'check'
                ? 'Checking the saved setup status…'
                : 'Continuing the original setup through the Android PIN dialog…'}
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {visible && (
            <div className="bundle-recovery-state">
              <strong>
                {visible.status === 'completed'
                  ? 'Original setup handoff completed'
                  : visible.status === 'ready'
                    ? 'Ready to continue setup'
                    : visible.status === 'pending'
                      ? 'Original setup needs confirmation'
                      : visible.status === 'blocked'
                        ? 'Next setup is blocked'
                        : 'No next setup step is available'}
              </strong>
              {visible.reasonCode && <p>{describeError(new Error(visible.reasonCode))}</p>}
              {visible.status === 'completed' && (
                <>
                  <p>
                    {visible.nextShiftId === null
                      ? 'The original shift is closed. Check Prepare offline access for the next opening-cash step.'
                      : 'Last confirmed status: the original shift is open. Check Prepare offline access to prepare another allocation for that same shift.'}
                  </p>
                  <p>
                    No new invoice allocation was prepared by this handoff. New sales remain paused.
                  </p>
                </>
              )}
              {(!fresh || checkedRevision !== revision) && (
                <p className="help">
                  Saved outcome. Check next setup before taking another action.
                </p>
              )}
              {visible.previousAuthorityId && (
                <details className="support-details">
                  <summary>Setup references</summary>
                  <p className="help">
                    Original allocation{' '}
                    <span className="reference">{visible.previousAuthorityId}</span>
                  </p>
                  <p className="help">
                    Original shift <span className="reference">{visible.shiftId}</span>
                  </p>
                </details>
              )}
            </div>
          )}
          {original && (
            <p className="access-note">
              Keep the original setup request. Check its saved status before retrying; a different
              allocation cannot replace it.
            </p>
          )}
          {actionsBlocked && (
            <p className="access-note">
              Check the saved payment in Counter first. Setup cannot continue while payment status
              needs attention or is unverified.
            </p>
          )}
          {visible && ['ready', 'pending'].includes(visible.status) && visible.canContinue && (
            <div className="bundle-recovery-confirm">
              <label className="cash-confirm">
                <input
                  type="checkbox"
                  checked={!!key && consent === key}
                  disabled={!mayContinue}
                  onChange={(event) => setConsent(event.target.checked ? key : null)}
                />
                <span>
                  I confirm continuing setup after allocation{' '}
                  <span className="reference">{visible.previousAuthorityId}</span>. Keep all
                  original records; do not close the cash shift or prepare a new allocation in this
                  step.
                </span>
              </label>
              <button
                className="secondary"
                disabled={!mayContinue || consent !== key}
                onClick={() => void proceed()}
              >
                {visible.status === 'pending' ? 'Retry same setup handoff' : 'Continue setup'}
              </button>
              <p className="help">
                Internet and the original staff account are required. Confirm in the Android PIN
                dialog.
              </p>
            </div>
          )}
          {visible?.status === 'completed' &&
            visible.shiftId !== null &&
            visible.nextShiftId === visible.shiftId && (
              <div className="bundle-recovery-confirm">
                <p>
                  Check whether the original shift is still open. This check cannot close the
                  drawer.
                </p>
                <label className="cash-confirm">
                  <input
                    type="checkbox"
                    checked={!!key && consent === `${key}:shift_status`}
                    disabled={!mayCheckShift}
                    onChange={(event) =>
                      setConsent(event.target.checked ? `${key}:shift_status` : null)
                    }
                  />
                  <span>
                    I confirm checking the original shift through the Android PIN dialog. Keep the
                    existing records and do not open or close a shift in this step.
                  </span>
                </label>
                <button
                  className="secondary"
                  disabled={!mayCheckShift || consent !== `${key}:shift_status`}
                  onClick={() => void proceed(true)}
                >
                  Check shift status
                </button>
              </div>
            )}
          <button
            className="secondary access-refresh"
            disabled={!ready || !listening || !!busy}
            onClick={() => void check()}
          >
            Check next setup
          </button>
        </>
      )}
    </section>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getNativePinRecoveryState,
  startNativePinRecovery,
  retryNativePinRecovery,
  nativeOfflineErrorCode,
  subscribeNativeCheckoutLock,
  type NativePinRecoveryState,
} from './native'

type Props = {
  available: boolean
  ready: boolean
  revision: number
  actorId: string | null
  operationLock: { current: boolean }
  onBusyChange: (busy: boolean) => void
  onPendingChange: (pending: boolean) => void
  onCheckedVersion: (revision: number) => void
  onChanged: () => void
}
const messages: Record<string, string> = {
  pin_recovery_pending:
    'The original PIN recovery is saved. Check or retry that same request; do not start a different PIN change.',
  pin_recovery_approved:
    'Approval is saved. Finish this recovery on the original device while signed in with the original staff account.',
  pin_recovery_completed:
    'Your new PIN is saved. The counter stays locked until you unlock with it.',
  pin_recovery_uncertain:
    'Recovery was not confirmed. Read the saved status before retrying the original request.',
  native_session_expired:
    'Sign in with the original staff account. A saved request can still be checked without starting another recovery.',
  clock_source_blocked:
    'Device time cannot be verified. PIN recovery cannot repair the device clock. Keep this app’s data and contact support.',
  native_storage_unavailable:
    'The saved recovery record cannot be read. Keep this app’s data and contact support.',
  pin_not_provisioned:
    'There is no saved offline PIN to recover. Complete normal offline preparation first.',
  offline_not_configured:
    'PIN recovery is not configured in this app build. Keep your records and ask for the approved update.',
  native_authentication_failed:
    'The original account could not be verified. Check the password in the Android dialog.',
  offline_context_changed:
    'The original account or device no longer matches. Keep the saved request and contact support.',
  pin_recovery_invalid:
    'The saved recovery cannot be verified. Keep this app’s data and contact support.',
  pin_recovery_conflict:
    'The saved recovery conflicts with another record. Keep this app’s data and contact support.',
  native_network_unavailable:
    'Connect to the internet and check the saved recovery before retrying.',
  native_pin_cancelled:
    'Android confirmation was cancelled. The saved status below shows whether a request still needs checking.',
  native_sign_in_cancelled:
    'Android confirmation was cancelled. Check the saved status before continuing.',
  pin_confirmation_mismatch:
    'The new PIN entries did not match. Check saved status, then enter them again in Android when prompted.',
}
const errorText = (failure: unknown) =>
  messages[nativeOfflineErrorCode(failure)] ??
  'PIN recovery could not be verified. Keep this app’s data and check saved status before trying again.'
const isPending = (value: NativePinRecoveryState) =>
  value.status === 'pending' ||
  value.status === 'approved' ||
  (value.status === 'blocked' && value.requestId !== null)

export default function NativePinRecovery({
  available,
  ready,
  revision,
  actorId,
  operationLock,
  onBusyChange,
  onPendingChange,
  onCheckedVersion,
  onChanged,
}: Props) {
  const [state, setState] = useState<NativePinRecoveryState | null>(null)
  const [checked, setChecked] = useState(-1),
    [fresh, setFresh] = useState(false)
  const [listening, setListening] = useState(false),
    [busy, setBusy] = useState(false)
  const [error, setError] = useState(''),
    [consent, setConsent] = useState<string | null>(null)
  const mounted = useRef(false),
    active = useRef(false),
    epoch = useRef(0)
  const original = useRef<string | null>(null),
    notified = useRef<string | null>(null)
  const scope = `${revision}:${actorId ?? ''}`,
    currentScope = useRef(scope)
  currentScope.current = scope
  const [readScope, setReadScope] = useState('')
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
      setFresh(false)
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
          setError('Device lock monitoring is unavailable. Keep saved records and contact support.')
        }
      })
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', invalidate)
      if (remove) void remove()
    }
  }, [available, onPendingChange])
  const current = (token: number, selected: string) =>
    mounted.current && token === epoch.current && selected === currentScope.current
  function begin() {
    if (!available || !ready || !listening || operationLock.current || active.current) return false
    operationLock.current = true
    active.current = true
    setBusy(true)
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
      setBusy(false)
      onBusyChange(false)
    }
  }
  function apply(
    next: NativePinRecoveryState,
    token: number,
    selected: string,
    expected: string | null
  ) {
    if (!current(token, selected)) return
    if (expected && next.requestId !== expected) {
      setError(errorText(new Error('offline_context_changed')))
      onPendingChange(true)
      return
    }
    setState(next)
    setFresh(true)
    setReadScope(selected)
    setChecked(revision)
    setConsent(null)
    onPendingChange(isPending(next))
    original.current = isPending(next) ? next.requestId : null
    if (next.status === 'completed' && next.requestId !== notified.current) {
      notified.current = next.requestId
      onChanged()
    }
  }
  const read = useCallback(async () => {
    if (!begin()) return
    const token = ++epoch.current,
      selected = scope
    try {
      apply(await getNativePinRecoveryState(), token, selected, original.current)
    } catch (failure) {
      if (current(token, selected)) {
        setError(errorText(failure))
        onPendingChange(true)
      }
    } finally {
      finish()
      if (current(token, selected)) {
        setChecked(revision)
        onCheckedVersion(revision)
      }
    }
    // The captured scope is checked before any native result is applied.
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
    if (ready && listening && checked !== revision) void read()
  }, [ready, listening, checked, revision, read])
  const currentState = fresh && checked === revision && readScope === scope
  const known = state?.reasonCode === null || !!(state?.reasonCode && messages[state.reasonCode])
  const mayStart = currentState && known && !!actorId && !!state?.canStart && !original.current
  const mayRetry = currentState && known && !!state?.canRetry && !!state.requestId
  const consentKey = `${scope}:${state?.status}:${state?.requestId ?? 'new'}:${state?.passwordRequired}`
  async function run(kind: 'start' | 'retry') {
    if (consent !== consentKey || (kind === 'start' ? !mayStart : !mayRetry) || !begin()) return
    const token = ++epoch.current,
      selected = scope
    const expected = kind === 'retry' ? state!.requestId : null
    onPendingChange(true)
    try {
      const next =
        kind === 'start' ? await startNativePinRecovery() : await retryNativePinRecovery(expected!)
      apply(next, token, selected, expected)
    } catch (failure) {
      if (!current(token, selected)) return
      setError(errorText(failure))
      // Only a local read follows uncertainty. No network write or replacement request is retried.
      try {
        apply(await getNativePinRecoveryState(), token, selected, expected)
      } catch {
        if (current(token, selected)) onPendingChange(true)
      }
    } finally {
      finish()
    }
  }
  const paused = !ready || !listening || busy
  return (
    <section className="bundle-recovery pin-recovery" aria-labelledby="pin-recovery-heading">
      <h3 id="pin-recovery-heading">Recover forgotten PIN</h3>
      <p>
        Use the original staff account, an internet connection and a device with verified time.
        Android handles your account password and new PIN privately.
      </p>
      <p className="help">
        Saved bills, payment records and invoice limits are preserved. This does not renew offline
        permission or repair a blocked device clock.
      </p>
      {!available ? (
        <p className="access-note">Open the installed Android app to recover its saved PIN.</p>
      ) : (
        <>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {!currentState && (
            <p className="help">
              Check saved PIN recovery status before starting or retrying. New payments and setup
              changes stay paused until checked.
            </p>
          )}
          {state?.requestId && (
            <p className="help recovery-reference">Recovery reference: {state.requestId}</p>
          )}
          {currentState && state?.reasonCode && (
            <p className="access-note" role="status">
              {messages[state.reasonCode] ??
                'Recovery is unavailable. Keep saved records and contact support.'}
            </p>
          )}
          {currentState && state?.status === 'completed' && (
            <p className="access-note">
              PIN recovery complete. Use the new PIN in the Android unlock dialog. New sales remain
              subject to the counter’s existing permissions and release limits.
            </p>
          )}
          {currentState && isPending(state!) && (
            <p className="help">
              Account changes and new sales are paused for this saved request. Uploading saved
              records and reviewing existing payments remain available.
            </p>
          )}
          <button className="secondary" disabled={paused} onClick={() => void read()}>
            {busy ? 'Checking PIN recovery…' : 'Check saved PIN recovery'}
          </button>
          {(mayStart || mayRetry) && (
            <>
              <label className="cash-confirm">
                <input
                  type="checkbox"
                  checked={consent === consentKey}
                  disabled={paused}
                  onChange={(event) => setConsent(event.target.checked ? consentKey : null)}
                />
                <span>
                  {mayRetry
                    ? 'Continue this exact saved PIN recovery. Keep its original account and new PIN; do not create a replacement request.'
                    : 'Recover the PIN for this original staff account. Keep all saved bills and existing invoice limits; leave the counter locked afterward.'}
                </span>
              </label>
              <button
                className="primary"
                disabled={paused || consent !== consentKey}
                onClick={() => void run(mayRetry ? 'retry' : 'start')}
              >
                {mayRetry
                  ? state?.status === 'approved'
                    ? 'Finish saved PIN recovery'
                    : 'Check / retry saved PIN recovery'
                  : state?.status === 'completed'
                    ? 'Recover PIN again'
                    : 'Continue in Android'}
              </button>
              {mayRetry && (
                <p className="help">
                  Android checks the original request first.
                  {state?.passwordRequired
                    ? ' It may ask for your current account password.'
                    : ' No account password is needed for the saved approval or status check.'}
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}

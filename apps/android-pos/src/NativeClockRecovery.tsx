import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getNativeClockBootstrapState,
  verifyNativeClockBootstrap,
  type NativeClockBootstrapState,
  getNativeClockRecoveryState,
  startNativeClockRecovery,
  retryNativeClockRecovery,
  nativeOfflineErrorCode,
  subscribeNativeCheckoutLock,
  type NativeClockRecoveryState,
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
  clock_bootstrap_uncertain:
    'The clock check was not confirmed. Check device time status before trying again. Keep this app’s data.',
  clock_bootstrap_not_eligible:
    'This counter needs its saved recovery process. Keep all records and check saved clock recovery.',
  clock_bootstrap_completed:
    'Device time checked. Continue setting up this counter. Offline selling is not enabled.',
  clock_healthy: 'Device time is verified. No clock recovery is needed.',
  clock_recovery_pending:
    'The original clock recovery is saved. Check or retry this exact request; do not create a replacement.',
  clock_recovery_approved:
    'Approval is saved. Correct Android automatic date and time, then finish on the original device with the original staff account. Android must obtain fresh signed time before completion.',
  clock_recovery_completed:
    'Clock recovery is complete. The counter remains locked. Your PIN and its attempt limits have not changed.',
  clock_recovery_conflict:
    'The saved recovery conflicts with another record. Keep all app data and contact support.',
  clock_recovery_interrupted:
    'Clock recovery was interrupted. Check the saved request before continuing.',
  clock_recovery_invalid:
    'The saved recovery cannot be verified. Keep all app data and contact support.',
  clock_recovery_uncertain:
    'Recovery was not confirmed. Check the saved status before retrying the original request.',
  clock_time_settings_required:
    'Correct automatic date and time in Android Settings, then return and check the saved recovery. Do not clear app data.',
  clock_signal_unavailable:
    'Android could not obtain a reliable time signal. Connect to the internet, check automatic date and time, then retry the saved recovery.',
  offline_context_changed:
    'The original account or device no longer matches. Keep the saved recovery and contact support.',
  native_session_expired:
    'Sign in with the original staff account to authorize or finish recovery. The saved request can still be checked.',
  offline_not_configured:
    'Clock recovery is not configured in this app build. Keep your records and ask for the approved update.',
  native_storage_unavailable:
    'The saved clock record cannot be read. Keep all app data and contact support.',
  native_network_unavailable:
    'Connect to the internet and check the saved recovery before retrying.',
  native_authentication_failed:
    'The original account could not be verified. Check your password only in the Android dialog.',
  native_sign_in_cancelled:
    'Android confirmation was cancelled. Check saved status before continuing.',
}
const errorText = (failure: unknown) =>
  messages[nativeOfflineErrorCode(failure)] ??
  'Clock recovery could not be verified. Keep this app’s data and check saved status before trying again.'
const bootstrapErrorText = (failure: unknown) => {
  const code = nativeOfflineErrorCode(failure)
  if (code === 'clock_time_settings_required' || code === 'clock_signal_unavailable')
    return 'Correct automatic date and time in Android Settings and connect to the internet. Return here, check device time status, then confirm again. Keep this app’s data.'
  if (code === 'native_sign_in_cancelled' || code === 'clock_recovery_interrupted')
    return 'The Android time check was cancelled or interrupted. Check device time status before confirming again.'
  return errorText(failure)
}
const isPending = (value: NativeClockRecoveryState) =>
  !(
    (value.status === 'not_available' && value.reasonCode === 'clock_healthy') ||
    (value.status === 'completed' && value.reasonCode === 'clock_recovery_completed')
  )

export default function NativeClockRecovery({
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
  const [bootstrap, setBootstrap] = useState<NativeClockBootstrapState | null>(null)
  const [bootstrapFresh, setBootstrapFresh] = useState(false)
  const [bootstrapScope, setBootstrapScope] = useState('')
  const actorEpoch = useRef(0),
    pausedEpoch = useRef(0),
    bootstrapNotified = useRef(false)
  const [state, setState] = useState<NativeClockRecoveryState | null>(null)
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
  const currentRevision = useRef(revision)
  currentRevision.current = revision
  const [readScope, setReadScope] = useState('')
  const previousActor = useRef(actorId)
  useEffect(() => {
    if (previousActor.current !== actorId) {
      previousActor.current = actorId
      actorEpoch.current++
      epoch.current++
      setBootstrap(null)
      setBootstrapFresh(false)
      bootstrapNotified.current = false
      original.current = null
      notified.current = null
      setState(null)
      setFresh(false)
      setConsent(null)
      setChecked(-1)
      onPendingChange(true)
    }
  }, [actorId, onPendingChange])
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
      setChecked(currentRevision.current)
      setFresh(false)
      setBootstrapFresh(false)
      setConsent(null)
      onPendingChange(true)
    }
    const pause = () => {
      pausedEpoch.current++
      invalidate()
    }
    const visibility = () => {
      if (document.visibilityState === 'hidden') pause()
    }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', pause)
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
      window.removeEventListener('pagehide', pause)
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
    setBootstrapFresh(false)
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
    next: NativeClockRecoveryState,
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
    original.current = ['pending', 'approved', 'blocked'].includes(next.status)
      ? next.requestId
      : null
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
      // Bootstrap capability is distinct from ordinary recovery. Neither an absent
      // account nor an unavailable capability proves the clock healthy.
      let nextBootstrap: NativeClockBootstrapState | null = null
      try {
        nextBootstrap = await getNativeClockBootstrapState()
      } catch {
        if (current(token, selected)) setBootstrap(null)
      }
      if (current(token, selected) && nextBootstrap) {
        setBootstrap(nextBootstrap)
        setBootstrapFresh(true)
        setBootstrapScope(selected)
        if (nextBootstrap.status === 'ready') bootstrapNotified.current = false
      }
      const next = await getNativeClockRecoveryState()
      apply(next, token, selected, original.current)
      if (
        current(token, selected) &&
        nextBootstrap?.status === 'completed' &&
        next.status === 'not_available' &&
        next.reasonCode === 'clock_healthy' &&
        !original.current &&
        !bootstrapNotified.current
      ) {
        bootstrapNotified.current = true
        onChanged()
      }
      return { clock: next, bootstrap: nextBootstrap }
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
    if (ready && listening && !busy && checked !== revision) void read()
  }, [ready, listening, busy, checked, revision, read])
  const currentState = fresh && checked === revision && readScope === scope
  const known = state?.reasonCode === null || !!(state?.reasonCode && messages[state.reasonCode])
  const mayStart = currentState && known && !!actorId && !!state?.canStart && !original.current
  const mayRetry = currentState && known && !!state?.canRetry && !!state.requestId
  const bootstrapMode =
    bootstrapScope === scope &&
    !state?.requestId &&
    !original.current &&
    (bootstrap?.status === 'ready' ||
      (bootstrap?.status === 'completed' &&
        currentState &&
        state?.status === 'not_available' &&
        state.reasonCode === 'clock_healthy'))
  const mayBootstrap =
    bootstrapMode && bootstrapFresh && checked === revision && bootstrap?.canVerify === true
  const bootstrapConsentKey = `bootstrap:${scope}`
  const consentKey = `${scope}:${state?.status}:${state?.requestId ?? 'new'}:${state?.passwordRequired}`
  async function run(kind: 'start' | 'retry') {
    if (consent !== consentKey || (kind === 'start' ? !mayStart : !mayRetry) || !begin()) return
    const token = ++epoch.current,
      selected = scope
    const expected = kind === 'retry' ? state!.requestId : null
    onPendingChange(true)
    try {
      const next =
        kind === 'start'
          ? await startNativeClockRecovery()
          : await retryNativeClockRecovery({ requestId: expected! })
      apply(next, token, selected, expected)
    } catch (failure) {
      if (!current(token, selected)) return
      setError(errorText(failure))
      // Only a local read follows uncertainty. No network write or replacement request is retried.
      try {
        apply(await getNativeClockRecoveryState(), token, selected, expected)
      } catch {
        if (current(token, selected)) onPendingChange(true)
      }
    } finally {
      finish()
    }
  }
  async function verifyBootstrap() {
    if (!mayBootstrap || consent !== bootstrapConsentKey || !begin()) return
    const selected = scope,
      pause = pausedEpoch.current,
      actor = actorEpoch.current
    let failure: unknown = null
    onPendingChange(true)
    try {
      // The native lock event invalidates the operation's UI result. Only fresh
      // reads below can release the ordinary clock hold; this never retries a write.
      await verifyNativeClockBootstrap()
    } catch (error) {
      failure = error
    } finally {
      finish()
    }
    if (
      !mounted.current ||
      selected !== currentScope.current ||
      pause !== pausedEpoch.current ||
      actor !== actorEpoch.current ||
      document.visibilityState === 'hidden'
    )
      return
    const verified = await read()
    if (
      failure &&
      !(
        verified?.bootstrap?.status === 'completed' &&
        verified.clock.status === 'not_available' &&
        verified.clock.reasonCode === 'clock_healthy'
      ) &&
      actor === actorEpoch.current &&
      mounted.current &&
      selected === currentScope.current &&
      pause === pausedEpoch.current
    )
      setError(bootstrapErrorText(failure))
  }
  const paused = !ready || !listening || busy
  return (
    <section className="bundle-recovery clock-recovery" aria-labelledby="clock-recovery-heading">
      <h3 id="clock-recovery-heading">
        {bootstrapMode ? 'Verify device time before setup' : 'Recover device time'}
      </h3>
      {bootstrapMode ? (
        <>
          <p>
            Turn on automatic date and time in Android Settings, connect to the internet, then
            return here.
          </p>
          <p className="help">
            Android will check the time before you continue setup. Confirm in the Android dialog; no
            password or PIN is needed for this check. You will still need to set up the counter
            separately. Offline selling stays unavailable.
          </p>
        </>
      ) : (
        <>
          <p>
            First correct automatic date and time in Android Settings. Connect to the internet and
            use the original staff account. Only the Android dialog asks for your account password.
          </p>
          <p className="help">
            Saved bills and payment holds are preserved. Approved recovery retires old offline
            allowances; it does not erase records, change your PIN or reset PIN attempt limits. The
            counter ends locked.
          </p>
        </>
      )}
      {!available ? (
        <p className="access-note">Open the installed Android app to recover its device time.</p>
      ) : (
        <>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {!currentState && (
            <p className="help">
              {bootstrapMode
                ? 'Check device time status before continuing. Setup changes stay paused until checked.'
                : 'Check saved clock recovery status before starting or retrying. New payments and setup changes stay paused until checked.'}
            </p>
          )}
          {readScope === scope && state?.requestId && (
            <p className="help recovery-reference">Recovery reference: {state.requestId}</p>
          )}
          {!bootstrapMode && currentState && state?.reasonCode && (
            <p className="access-note" role="status">
              {messages[state.reasonCode] ??
                'Recovery is unavailable. Keep saved records and contact support.'}
            </p>
          )}
          {!bootstrapMode && currentState && state?.status === 'completed' && (
            <p className="access-note">
              Clock recovery complete. The counter remains locked. Check offline setup separately;
              old allowances cannot be reused and this confirmation does not make offline selling
              ready.
            </p>
          )}
          {!bootstrapMode && currentState && isPending(state!) && (
            <p className="help">
              Account changes, new sales and offline setup are paused until device time is
              recovered. Uploading saved records and reviewing existing payments remain available.
            </p>
          )}
          <button className="secondary" disabled={paused} onClick={() => void read()}>
            {busy
              ? 'Checking device time…'
              : bootstrapMode
                ? 'Check device time status'
                : 'Check saved clock recovery'}
          </button>
          {bootstrapMode && bootstrapFresh && bootstrap?.status === 'completed' && (
            <p className="access-note" role="status">
              {messages.clock_bootstrap_completed} Existing account, payment and PIN checks still
              apply; the counter stays locked.
            </p>
          )}
          {mayBootstrap && (
            <>
              <label className="cash-confirm">
                <input
                  type="checkbox"
                  checked={consent === bootstrapConsentKey}
                  disabled={paused}
                  onChange={(event) =>
                    setConsent(event.target.checked ? bootstrapConsentKey : null)
                  }
                />
                <span>
                  I have corrected Android automatic date and time. Continue to Android’s
                  confirmation to check the time.
                </span>
              </label>
              <button
                className="primary"
                disabled={paused || consent !== bootstrapConsentKey}
                onClick={() => void verifyBootstrap()}
              >
                Verify clock in Android
              </button>
              <p className="help">
                Setup stays paused until the clock is checked. Saved records and existing PIN,
                payment and account restrictions are kept.
              </p>
            </>
          )}
          {!bootstrapMode && (mayStart || mayRetry) && (
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
                    ? 'Continue this exact saved clock recovery on the original account and device. Keep saved bills and payment holds; do not create a replacement request.'
                    : 'Recover device time for this original staff account. Preserve bills and payment holds, retire old offline allowances on approval, and leave the counter locked.'}
                </span>
              </label>
              <button
                className="primary"
                disabled={paused || consent !== consentKey}
                onClick={() => void run(mayRetry ? 'retry' : 'start')}
              >
                {mayRetry
                  ? state?.status === 'approved'
                    ? 'Finish clock recovery'
                    : 'Check / retry clock recovery'
                  : state?.status === 'completed'
                    ? 'Recover device time again'
                    : 'Continue clock recovery in Android'}
              </button>
              {mayRetry && (
                <p className="help">
                  Android checks the original request first.
                  {state?.passwordRequired
                    ? ' It may ask for your current account password.'
                    : ' Status lookup uses the saved request. Finishing an approval still needs the original account and fresh verified time.'}
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  )
}

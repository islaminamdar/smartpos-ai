import { useEffect, useRef, useState } from 'react'
import {
  type NativeBundleRecoveryState,
  readNativeBundleRecovery,
  recoverNativeMissingBundle,
  knownBundleRecoveryReason,
  nativeBundleRecoveryError,
} from './native'

type Props = {
  available: boolean
  ready: boolean
  revision: number
  actionsBlocked: boolean
  operationLock: { current: boolean }
  onBusyChange: (busy: boolean) => void
  onChanged: () => void
}
export default function NativeBundleRecovery({
  available,
  ready,
  revision,
  actionsBlocked,
  operationLock,
  onBusyChange,
  onChanged,
}: Props) {
  const [state, setState] = useState<NativeBundleRecoveryState | null>(null)
  const [checkedVersion, setCheckedVersion] = useState(-1)
  const [fresh, setFresh] = useState(false)
  const [busy, setBusy] = useState<'check' | 'recover' | null>(null)
  const [consent, setConsent] = useState<string | null>(null)
  const [pendingAuthority, setPendingAuthority] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const mounted = useRef(false)
  const epoch = useRef(0)
  const lock = useRef(false)
  const currentRevision = useRef(revision)
  currentRevision.current = revision
  useEffect(() => {
    mounted.current = true
    const invalidate = () => {
      epoch.current++
      setFresh(false)
      setConsent(null)
    }
    const visibility = () => {
      if (document.visibilityState === 'hidden') invalidate()
    }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', invalidate)
    return () => {
      mounted.current = false
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', invalidate)
    }
  }, [])
  const start = (kind: 'check' | 'recover') => {
    if (!available || !ready || operationLock.current || lock.current) return false
    operationLock.current = true
    lock.current = true
    setBusy(kind)
    onBusyChange(true)
    setError('')
    setNotice('')
    setConsent(null)
    return true
  }
  const finish = () => {
    operationLock.current = false
    lock.current = false
    if (mounted.current) {
      setBusy(null)
      onBusyChange(false)
    }
  }
  const apply = (
    next: NativeBundleRecoveryState,
    version: number,
    operationEpoch: number,
    original: string | null
  ) => {
    if (!mounted.current || operationEpoch !== epoch.current || version !== currentRevision.current)
      return false
    if (original && next.authorityId !== original) {
      setFresh(false)
      setError(nativeBundleRecoveryError(new Error('offline_context_changed')))
      return false
    }
    setState(next)
    setCheckedVersion(version)
    setFresh(true)
    setConsent(null)
    if (next.status === 'retained') {
      setPendingAuthority(null)
      setError('')
      setNotice(
        'Original allocation recovered and permanently finished on this device. Use Upload saved records for server confirmation. New sales remain paused.'
      )
      return true
    }
    return false
  }
  async function check() {
    if (!start('check')) return
    const version = revision,
      operationEpoch = epoch.current
    setFresh(false)
    try {
      const next = await readNativeBundleRecovery()
      const retained = apply(next, version, operationEpoch, pendingAuthority)
      if (retained && state?.status !== 'retained') onChanged()
    } catch (failure) {
      if (mounted.current && operationEpoch === epoch.current)
        setError(nativeBundleRecoveryError(failure))
    } finally {
      finish()
    }
  }
  const paused =
    !available ||
    !ready ||
    !!busy ||
    !fresh ||
    checkedVersion !== revision ||
    actionsBlocked ||
    !state ||
    !knownBundleRecoveryReason(state.reasonCode)
  const mayRecover =
    !paused &&
    state?.status === 'available' &&
    state.canRecover &&
    !!state.authorityId &&
    (!pendingAuthority || pendingAuthority === state.authorityId)
  async function recover() {
    if (!mayRecover || !state?.authorityId || consent !== state.authorityId) return
    const authorityId = state.authorityId
    if (!start('recover')) return
    const version = revision,
      operationEpoch = epoch.current
    setPendingAuthority(authorityId)
    setFresh(false)
    let retained = false
    try {
      const next = await recoverNativeMissingBundle(authorityId)
      retained = apply(next, version, operationEpoch, authorityId)
    } catch (failure) {
      if (mounted.current && operationEpoch === epoch.current)
        setError(nativeBundleRecoveryError(failure))
      try {
        const next = await readNativeBundleRecovery()
        retained = apply(next, version, operationEpoch, authorityId)
      } catch (readFailure) {
        if (mounted.current && operationEpoch === epoch.current) {
          setFresh(false)
          setError(nativeBundleRecoveryError(readFailure))
        }
      }
    } finally {
      finish()
      if (retained) onChanged()
    }
  }
  return (
    <section className="bundle-recovery" aria-labelledby="bundle-recovery-heading">
      <h3 id="bundle-recovery-heading">Recover a missing allocation</h3>
      <p>
        If invoice numbers were reserved but the signed setup was not saved, recover and permanently
        finish that same allocation. This keeps its original invoice numbers accounted for.
      </p>
      {!available ? (
        <p className="help">Open the installed Android app to check its saved recovery record.</p>
      ) : (
        <>
          <p className="help">
            Checking status only reads this device. Recovery needs internet and this installation’s
            signed device proof; no staff sign-in or PIN is required. It does not enable sales,
            renew permission, reserve new invoice numbers or close the cash shift.
          </p>
          {busy && (
            <p className="access-note" role="status">
              {busy === 'check'
                ? 'Checking the saved allocation…'
                : 'Recovering and permanently finishing the original allocation…'}
            </p>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="access-note" role="status">
              {notice}
            </p>
          )}
          {state && (
            <div className="bundle-recovery-state">
              <strong>
                {state.status === 'available'
                  ? 'A missing allocation can be recovered'
                  : state.status === 'retained'
                    ? 'Original allocation retained and finished'
                    : state.status === 'blocked'
                      ? 'Recovery is blocked'
                      : 'No missing allocation needs recovery'}
              </strong>
              {state.authorityId && (
                <p className="help">
                  Allocation reference <span className="reference">{state.authorityId}</span>
                </p>
              )}
              {state.status !== 'retained' && (!fresh || checkedVersion !== revision) && (
                <p className="help">
                  Last checked status. Check again before making a recovery request.
                </p>
              )}
              {state.reasonCode && <p>{nativeBundleRecoveryError(new Error(state.reasonCode))}</p>}
            </div>
          )}
          {pendingAuthority && (
            <p className="access-note">
              Keep the original recovery reference {pendingAuthority}. Check its saved status before
              retrying. A different allocation cannot replace this request.
            </p>
          )}
          {actionsBlocked && (
            <p className="access-note">
              Check the saved payment in Counter first. Recovery cannot run while a payment needs
              attention or its status is unverified.
            </p>
          )}
          {state?.status === 'available' && state.authorityId && (
            <div className="bundle-recovery-confirm">
              <label className="cash-confirm">
                <input
                  type="checkbox"
                  checked={consent === state.authorityId}
                  disabled={!mayRecover}
                  onChange={(event) => setConsent(event.target.checked ? state.authorityId : null)}
                />
                <span>
                  I confirm recovering and permanently finishing allocation {state.authorityId}.
                  These invoice numbers will not be used for new sales.
                </span>
              </label>
              <button
                className="secondary"
                disabled={!mayRecover || consent !== state.authorityId}
                onClick={() => void recover()}
              >
                Recover missing allocation
              </button>
            </div>
          )}
          <button
            className="secondary access-refresh"
            disabled={!ready || !!busy}
            onClick={() => void check()}
          >
            Check missing allocation
          </button>
        </>
      )}
    </section>
  )
}

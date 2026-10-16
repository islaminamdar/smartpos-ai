import { useCallback, useEffect, useRef, useState } from 'react'
import {
  hasNativeLedger,
  readDeviceSnapshot,
  type DeviceSnapshot,
  readAccessState,
  signInNative,
  signOutNative,
  enrollNativeCounter,
  nativeAccessError,
  nativeAccessErrorCode,
  type NativeAccessState,
  type NativeOfflineState,
  readOfflineState,
  openNativeOfflineShift,
  prepareNativeOffline,
  unlockNativeOffline,
  lockNativeOffline,
  nativeOfflineError,
  nativeOfflineErrorCode,
  openingCashToFils,
} from './native'
import './app.css'

const date = (value: string) =>
  new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Dubai',
  }).format(new Date(value))

function OfflinePreparation({
  available,
  accessBusy,
  accessVersion,
  operationLock,
  onBusyChange,
  onCheckedVersion,
}: {
  available: boolean
  accessBusy: boolean
  accessVersion: number
  operationLock: { current: boolean }
  onBusyChange: (busy: boolean) => void
  onCheckedVersion: (version: number) => void
}) {
  const [state, setState] = useState<NativeOfflineState | null>(null)
  const [fresh, setFresh] = useState(false)
  const [checkedVersion, setCheckedVersion] = useState(-1)
  const [confirmedVersion, setConfirmedVersion] = useState(-1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [openingCash, setOpeningCash] = useState('')
  const [confirmedAmount, setConfirmedAmount] = useState<number | null>(null)
  const mounted = useRef(false)
  const localLock = useRef(false)
  const check = useCallback(async () => {
    if (!available || operationLock.current || localLock.current) return
    operationLock.current = true
    localLock.current = true
    setBusy(true)
    onBusyChange(true)
    setFresh(false)
    setError('')
    try {
      const next = await readOfflineState()
      if (mounted.current) {
        setState(next)
        setFresh(true)
        setCheckedVersion(accessVersion)
      }
    } catch (failure) {
      if (mounted.current) setError(nativeOfflineError(failure))
    } finally {
      operationLock.current = false
      localLock.current = false
      if (mounted.current) {
        setBusy(false)
        onBusyChange(false)
        onCheckedVersion(accessVersion)
      }
    }
  }, [available, operationLock, onBusyChange, onCheckedVersion, accessVersion])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!accessBusy && checkedVersion !== accessVersion) void check()
  }, [accessBusy, accessVersion, checkedVersion, check])
  const amount = openingCashToFils(openingCash)
  const paused = !fresh || checkedVersion !== accessVersion || busy || accessBusy
  async function execute(action: 'open_shift' | 'prepare' | 'unlock' | 'lock', retry = false) {
    if (paused || !state || operationLock.current || localLock.current) return
    const savedAmount = retry ? state.pendingOpeningCashFils : amount
    if (retry ? state.pendingAction !== action : !!state.pendingAction) return
    if (
      !retry &&
      ((action === 'open_shift' &&
        (state.stage !== 'open_shift' ||
          savedAmount === null ||
          confirmedAmount !== savedAmount ||
          confirmedVersion !== accessVersion)) ||
        (action === 'prepare' && state.stage !== 'prepare') ||
        (action === 'unlock' && state.stage !== 'unlock') ||
        (action === 'lock' && state.status !== 'prepared'))
    )
      return
    if (action === 'open_shift' && savedAmount === null) return
    operationLock.current = true
    localLock.current = true
    setBusy(true)
    onBusyChange(true)
    setFresh(false)
    setError('')
    setNotice('')
    try {
      const next = await (action === 'open_shift'
        ? openNativeOfflineShift(savedAmount!)
        : action === 'prepare'
          ? prepareNativeOffline()
          : action === 'unlock'
            ? unlockNativeOffline()
            : lockNativeOffline())
      if (mounted.current) {
        setState(next)
        setFresh(true)
        setCheckedVersion(accessVersion)
        setConfirmedAmount(null)
        setNotice(
          next.status === 'prepared'
            ? 'Offline preparation saved. New sales are still paused in this app version.'
            : action === 'lock'
              ? 'Local offline access locked. Saved records are kept.'
              : 'Setup status updated. Review the next step below.'
        )
      }
    } catch (failure) {
      if (mounted.current) {
        if (nativeOfflineErrorCode(failure) === 'native_pin_cancelled')
          setNotice(nativeOfflineError(failure))
        else setError(nativeOfflineError(failure))
      }
      // Read-only reconciliation discovers a durable pending request; it never retries a write.
      try {
        const next = await readOfflineState()
        if (mounted.current) {
          setState(next)
          setFresh(true)
          setCheckedVersion(accessVersion)
        }
      } catch {
        if (mounted.current) setFresh(false)
      }
    } finally {
      operationLock.current = false
      localLock.current = false
      if (mounted.current) {
        setBusy(false)
        onBusyChange(false)
      }
    }
  }
  const labels = {
    not_prepared: 'Not prepared',
    locked: 'Prepared access is locked',
    prepared: 'Offline preparation saved',
    blocked: 'Preparation needs attention',
  }
  return (
    <section className="offline-preparation" aria-labelledby="offline-heading">
      <h3 id="offline-heading">Prepare offline access</h3>
      <p>
        Save this counter’s menu, signed permission and invoice allocation. New sales remain paused
        until the billing screen is enabled and verified.
      </p>
      {!available ? (
        <p className="help">Open the installed Android app to prepare this counter.</p>
      ) : (
        <>
          {busy && (
            <p role="status" className="access-note">
              Checking setup or waiting for the Android dialog…
            </p>
          )}
          {error && (
            <div className="error" role="alert">
              <strong>Offline setup needs checking</strong>
              <p>{error}</p>
            </div>
          )}
          {notice && (
            <p role="status" className="access-note">
              {notice}
            </p>
          )}
          {state && (
            <>
              <p className="offline-state">
                <strong>{fresh ? labels[state.status] : 'Last checked setup — check again'}</strong>
              </p>
              {state.noticeCode && nativeOfflineError({ code: state.noticeCode }) !== error && (
                <p className="help">{nativeOfflineError({ code: state.noticeCode })}</p>
              )}
              {state.authority && (
                <dl className="record-values offline-details">
                  <div>
                    <dt>Saved permission expires</dt>
                    <dd>{date(state.authority.expiresAt)} Dubai time</dd>
                  </div>
                  <div>
                    <dt>Allocated invoice numbers</dt>
                    <dd>
                      {state.authority.firstInvoice}–{state.authority.lastInvoice}
                    </dd>
                  </div>
                </dl>
              )}
              {state.pendingAction ? (
                <div className="pending-setup">
                  <h4>Saved setup request needs confirmation</h4>
                  <p>
                    {state.pendingAction === 'open_shift'
                      ? `Opening cash: AED ${(state.pendingOpeningCashFils! / 100).toFixed(2)}. Retry this saved shift request with the same amount.`
                      : 'Retry the saved preparation request. Its original counter, shift and request identity are preserved.'}
                  </p>
                  <button
                    className="primary"
                    disabled={paused}
                    onClick={() => void execute(state.pendingAction!, true)}
                  >
                    Retry saved{' '}
                    {state.pendingAction === 'open_shift' ? 'shift request' : 'preparation'}
                  </button>
                  <p className="help">
                    Do not start a replacement request, change the opening cash or clear this app’s
                    data.
                  </p>
                </div>
              ) : (
                <>
                  {state.stage === 'sign_in' && (
                    <p className="help">Use secure sign-in above, then check offline status.</p>
                  )}
                  {state.stage === 'enroll_counter' && (
                    <p className="help">
                      Enroll this counter above before preparing offline access.
                    </p>
                  )}
                  {state.stage === 'open_shift' && (
                    <div className="offline-shift">
                      <label>
                        Opening cash (AED)
                        <input
                          inputMode="decimal"
                          autoComplete="off"
                          value={openingCash}
                          disabled={paused}
                          placeholder="0.00"
                          onChange={(event) => {
                            setOpeningCash(event.target.value)
                            setConfirmedAmount(null)
                          }}
                        />
                      </label>
                      <p className="help">
                        Count the cash already in this counter’s drawer. This opens a shift; it does
                        not record a sale.
                      </p>
                      {openingCash && amount === null && (
                        <p role="alert">
                          Enter an amount from AED 0.00 to 1,000,000.00, using up to two decimal
                          places.
                        </p>
                      )}
                      <label className="cash-confirm">
                        <input
                          type="checkbox"
                          checked={
                            amount !== null &&
                            confirmedAmount === amount &&
                            confirmedVersion === accessVersion
                          }
                          disabled={paused || amount === null}
                          onChange={(event) => {
                            setConfirmedAmount(event.target.checked ? amount : null)
                            setConfirmedVersion(accessVersion)
                          }}
                        />
                        <span>
                          I confirm opening cash
                          {amount === null ? '' : ` of AED ${(amount / 100).toFixed(2)}`} for this
                          counter.
                        </span>
                      </label>
                      <button
                        className="primary"
                        disabled={
                          paused ||
                          amount === null ||
                          confirmedAmount !== amount ||
                          confirmedVersion !== accessVersion
                        }
                        onClick={() => void execute('open_shift')}
                      >
                        Open counter shift
                      </button>
                    </div>
                  )}
                  {state.stage === 'prepare' && (
                    <>
                      <button
                        className="primary"
                        disabled={paused}
                        onClick={() => void execute('prepare')}
                      >
                        Prepare this counter
                      </button>
                      <p className="help">
                        Requires internet. Android will ask you to set or enter your local PIN. No
                        PIN is entered on this screen.
                      </p>
                    </>
                  )}
                  {state.stage === 'unlock' && (
                    <button
                      className="primary"
                      disabled={paused}
                      onClick={() => void execute('unlock')}
                    >
                      Unlock with Android PIN
                    </button>
                  )}
                  {state.status === 'prepared' && (
                    <>
                      <p className="help">
                        Menu and permission are saved. This is preparation only; collecting or
                        recording payment is not available here.
                      </p>
                      <button
                        className="secondary"
                        disabled={paused}
                        onClick={() => void execute('lock')}
                      >
                        Lock offline access
                      </button>
                    </>
                  )}
                  {state.stage === 'recover' && (
                    <p className="help">
                      Keep this device’s records and contact your manager or support. This app
                      cannot repair permission, time or counter changes. A local status check does
                      not renew access.
                    </p>
                  )}
                </>
              )}
            </>
          )}
          <button
            className="secondary access-refresh"
            disabled={busy || accessBusy}
            onClick={() => void check()}
          >
            Check offline status
          </button>
          <p className="help">
            This check reads saved device status only. It does not connect, prepare access or retry
            a request.
          </p>
        </>
      )}
    </section>
  )
}

function NativeAccess({ available }: { available: boolean }) {
  const [access, setAccess] = useState<NativeAccessState | null>(null)
  const [fresh, setFresh] = useState(false)
  const [busy, setBusy] = useState<'check' | 'signin' | 'signout' | 'enroll' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pendingLogout, setPendingLogout] = useState(false)
  const [offlineBusy, setOfflineBusy] = useState(false)
  const [accessInitialized, setAccessInitialized] = useState(false)
  const [accessVersion, setAccessVersion] = useState(0)
  const [offlineCheckedVersion, setOfflineCheckedVersion] = useState(-1)
  const [branchId, setBranchId] = useState('')
  const [name, setName] = useState('')
  const locked = useRef(false)
  const mounted = useRef(false)
  const apply = useCallback((next: NativeAccessState) => {
    setAccessVersion((version) => version + 1)
    setAccess(next)
    setFresh(true)
    setBranchId(
      (previous) =>
        next.device?.branchId ??
        (next.branches.some((branch) => branch.id === previous)
          ? previous
          : next.branches.length === 1
            ? next.branches[0].id
            : '')
    )
    if (next.status === 'signed_out') setName('')
  }, [])
  const check = useCallback(async () => {
    if (!available || locked.current) return
    locked.current = true
    setBusy('check')
    setFresh(false)
    setError('')
    setNotice('')
    try {
      const next = await readAccessState()
      if (mounted.current) apply(next)
    } catch (failure) {
      if (mounted.current) setError(nativeAccessError(failure))
    } finally {
      locked.current = false
      if (mounted.current) {
        setBusy(null)
        setAccessInitialized(true)
      }
    }
  }, [available, apply])
  useEffect(() => {
    mounted.current = true
    void check()
    return () => {
      mounted.current = false
    }
  }, [check])
  const branch = access?.branches.find((candidate) => candidate.id === branchId)
  async function change(kind: 'signin' | 'signout' | 'enroll') {
    if (
      !available ||
      locked.current ||
      !fresh ||
      !access ||
      offlineCheckedVersion !== accessVersion
    )
      return
    if (kind === 'signin' && (access.status !== 'signed_out' || pendingLogout)) return
    if (
      kind !== 'signin' &&
      access.status !== 'signed_in' &&
      !(kind === 'signout' && pendingLogout)
    )
      return
    if (
      kind === 'enroll' &&
      (access.device ||
        !branch ||
        branch.role === 'cashier' ||
        !name.trim() ||
        name.trim().length > 80)
    )
      return
    locked.current = true
    setBusy(kind)
    setError('')
    setNotice('')
    const actorId = access.actorId
    try {
      const next = await (kind === 'signin'
        ? signInNative()
        : kind === 'signout'
          ? signOutNative()
          : enrollNativeCounter({ branchId, name: name.trim() }))
      if (kind === 'enroll' && (next.actorId !== actorId || next.device?.branchId !== branchId))
        throw new Error('invalid_native_response')
      if (mounted.current) {
        apply(next)
        if (kind === 'signout') setPendingLogout(false)
        setNotice(
          kind === 'signin'
            ? 'Signed in. Offline sales are still paused.'
            : kind === 'signout'
              ? 'Signed out. Saved device records have not been removed.'
              : 'Counter enrolled. Prepare offline access below; new sales remain paused.'
        )
      }
    } catch (failure) {
      if (mounted.current) {
        if (nativeAccessErrorCode(failure) === 'native_sign_out_pending') {
          setPendingLogout(true)
          setFresh(false)
          setNotice(nativeAccessError(failure))
          try {
            const next = await readAccessState()
            if (next.status !== 'signed_out') throw new Error('invalid_native_response')
            if (mounted.current) apply(next)
          } catch (readFailure) {
            if (mounted.current) setError(nativeAccessError(readFailure))
          }
        } else if (
          kind === 'signin' &&
          nativeAccessErrorCode(failure) === 'native_sign_in_cancelled'
        )
          setNotice('Sign-in cancelled.')
        else {
          setFresh(false)
          setError(nativeAccessError(failure))
        }
      }
    } finally {
      locked.current = false
      if (mounted.current) setBusy(null)
    }
  }
  const paused = !!busy || offlineBusy || !fresh || offlineCheckedVersion !== accessVersion
  return (
    <section className="setup-panel" aria-labelledby="setup-heading">
      <h2 id="setup-heading">
        {access?.device ? 'Your counter access' : 'Connect to set up your counter'}
      </h2>
      <p>
        Sign in through the Android dialog, then enroll this counter for your branch. Internet is
        required for account access and enrollment.
      </p>
      {!available ? (
        <p className="access-note">
          Secure sign-in is available in the installed Android app. Passwords are never entered on
          this screen.
        </p>
      ) : (
        <>
          {busy && (
            <p className="access-note" role="status">
              {busy === 'check'
                ? 'Checking account access…'
                : busy === 'signin'
                  ? 'Complete sign-in in the Android dialog.'
                  : busy === 'signout'
                    ? 'Signing out…'
                    : 'Confirming counter enrollment…'}
            </p>
          )}
          {error && (
            <div className="error access-error" role="alert">
              <h3>Access needs checking</h3>
              <p>{error}</p>
              {access && (
                <p>
                  The last confirmed account is shown. Account changes are paused until access is
                  checked.
                </p>
              )}
            </div>
          )}
          {notice && (
            <p className="access-note" role="status">
              {notice}
            </p>
          )}
          {access?.status === 'signed_out' && (
            <div className="access-actions">
              <button
                className="primary"
                disabled={paused || pendingLogout}
                onClick={() => void change('signin')}
              >
                Sign in securely
              </button>
              <p className="help">
                The Android dialog handles your credentials. Signing in does not enable offline
                sales.
              </p>
            </div>
          )}
          {access?.status === 'signed_in' && (
            <>
              <div className="access-account">
                <strong>{fresh ? 'Signed in' : 'Last confirmed account'}</strong>
                <span>Staff reference {access.actorId}</span>
              </div>
              {access.branches.length === 0 ? (
                <p className="access-note">
                  No restaurant branches are available for this account. Ask your branch owner to
                  check your access.
                </p>
              ) : access.device ? (
                <dl className="record-values access-device">
                  <div>
                    <dt>Enrolled counter</dt>
                    <dd>{access.device.name}</dd>
                  </div>
                  <div>
                    <dt>Restaurant branch</dt>
                    <dd>
                      {branch?.name ??
                        access.branches.find((item) => item.id === access.device?.branchId)?.name}
                    </dd>
                  </div>
                  <div>
                    <dt>Your role</dt>
                    <dd className="role-name">{branch?.role}</dd>
                  </div>
                </dl>
              ) : (
                <div className="enrollment-form">
                  <label>
                    Restaurant branch
                    <select
                      value={branchId}
                      onChange={(event) => setBranchId(event.target.value)}
                      disabled={paused}
                    >
                      <option value="">Select your branch</option>
                      {access.branches.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} — {item.role}
                        </option>
                      ))}
                    </select>
                  </label>
                  {branch && (
                    <p className="help selected-branch">
                      Selected branch: <strong>{branch.name}</strong>.<br />
                      Your role: <strong className="role-name">{branch.role}</strong>.
                    </p>
                  )}
                  {branch?.role === 'cashier' ? (
                    <p className="access-note">
                      A manager or owner must enroll this counter. Sign out so they can complete
                      setup with their own account.
                    </p>
                  ) : (
                    <>
                      <label>
                        Counter name
                        <input
                          value={name}
                          onChange={(event) => setName(event.target.value)}
                          maxLength={80}
                          autoComplete="off"
                          placeholder="For example, Front counter"
                          disabled={paused || !branch}
                        />
                      </label>
                      <button
                        className="primary"
                        disabled={paused || !branch || !name.trim()}
                        onClick={() => void change('enroll')}
                      >
                        Enroll this counter
                      </button>
                      <p className="help">
                        Enroll only this installation for the selected branch. This does not prepare
                        a menu or permit offline billing.
                      </p>
                    </>
                  )}
                </div>
              )}
              <button
                className="secondary signout"
                disabled={paused}
                onClick={() => void change('signout')}
              >
                Sign out of this app
              </button>
            </>
          )}
          {pendingLogout && (
            <div className="access-note">
              <p>New sign-in is paused until server sign-out is confirmed.</p>
              <button
                className="secondary"
                disabled={paused || !access}
                onClick={() => void change('signout')}
              >
                Finish sign-out
              </button>
            </div>
          )}
          <button
            className="secondary access-refresh"
            disabled={!!busy || offlineBusy}
            onClick={() => void check()}
          >
            {busy === 'check' ? 'Checking access…' : 'Check access'}
          </button>
        </>
      )}
      <OfflinePreparation
        available={available}
        accessBusy={!!busy || !accessInitialized}
        accessVersion={accessVersion}
        operationLock={locked}
        onBusyChange={setOfflineBusy}
        onCheckedVersion={setOfflineCheckedVersion}
      />
      <a
        className="external-link"
        href="https://pos.internext.info/counter"
        target="_blank"
        rel="noopener noreferrer"
      >
        Open online web counter <span aria-hidden="true">↗</span>
      </a>
      <p className="help">
        Opens separately and requires internet and staff sign-in. The web counter does not enroll
        this Android installation.
      </p>
    </section>
  )
}

export default function App() {
  const [view, setView] = useState<'device' | 'receipts'>('device')
  const [snapshot, setSnapshot] = useState<DeviceSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(false)
  const native = hasNativeLedger()
  const refresh = useCallback(async () => {
    if (inFlight.current || !native) return
    inFlight.current = true
    setBusy(true)
    try {
      const next = await readDeviceSnapshot()
      if (mounted.current) {
        setSnapshot(next)
        setFailed(false)
      }
    } catch {
      if (mounted.current) setFailed(true)
    } finally {
      inFlight.current = false
      if (mounted.current) setBusy(false)
    }
  }, [native])
  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
    }
  }, [refresh])
  const unavailable = !native || !snapshot

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ▥
          </span>
          <strong>
            Internext <span>POS</span>
          </strong>
        </div>
        <span className="platform">Android counter</span>
      </header>
      <div className="workspace">
        <nav className="navigation" aria-label="App navigation">
          <button
            aria-current={view === 'device' ? 'page' : undefined}
            onClick={() => setView('device')}
          >
            This device
          </button>
          <button
            aria-current={view === 'receipts' ? 'page' : undefined}
            onClick={() => setView('receipts')}
          >
            Saved receipts
          </button>
        </nav>
        <main id="main" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <p className="eyebrow">{view === 'device' ? 'Device setup' : 'Local history'}</p>
              <h1>{view === 'device' ? 'Get this counter ready.' : 'Saved receipts'}</h1>
            </div>
            {native && (
              <button className="secondary" onClick={() => void refresh()} disabled={busy}>
                {busy ? 'Checking…' : 'Refresh device status'}
              </button>
            )}
          </div>
          <section className="status-strip" aria-label="Selling status">
            <strong>New sales paused</strong>
            <p>
              {!native
                ? 'Native storage is unavailable in this browser. Open the installed Android app to check this device.'
                : 'Offline preparation can save this counter’s setup. Recording new sales is not enabled in this app version.'}
            </p>
          </section>
          {busy && !snapshot && (
            <p role="status" className="message">
              Checking this device’s saved records…
            </p>
          )}
          {failed && (
            <section className="error" role="alert">
              <h2>Device records could not be checked.</h2>
              <p>
                {snapshot
                  ? 'The last successful check is shown below. These figures may have changed.'
                  : 'Receipt and sync counts are unavailable. They are not zero.'}{' '}
                Keep this app’s data and retry the check. Do not clear storage or reinstall to
                resolve this.
              </p>
              <button className="secondary" disabled={busy} onClick={() => void refresh()}>
                Retry check
              </button>
            </section>
          )}
          {!native && (
            <p className="message">
              This is the app screen in a browser. It does not have access to Android’s local ledger
              and cannot make this device ready for offline selling.
            </p>
          )}
          <div className="device-layout" hidden={view !== 'device'}>
            <NativeAccess available={native} />
            <section className="records-panel" aria-labelledby="records-heading">
              <h2 id="records-heading">Records on this device</h2>
              <dl className="record-values">
                <div>
                  <dt>Saved receipts</dt>
                  <dd>{snapshot ? snapshot.status.receiptCount : 'Unavailable'}</dd>
                </div>
                <div>
                  <dt>Waiting for server confirmation</dt>
                  <dd>{snapshot ? snapshot.status.pendingCount : 'Unavailable'}</dd>
                </div>
                <div>
                  <dt>Last server acknowledgement</dt>
                  <dd>
                    {snapshot?.status.lastAcknowledgedAt
                      ? `${date(snapshot.status.lastAcknowledgedAt)} Dubai time`
                      : snapshot
                        ? 'None recorded'
                        : 'Unavailable'}
                  </dd>
                </div>
              </dl>
              {snapshot && (
                <p className="help">
                  {failed ? 'Last successful check' : 'Device checked'} {date(snapshot.checkedAt)}{' '}
                  Dubai time. A device check does not synchronize sales.
                </p>
              )}
              <p className="help">
                Keep this app’s data. Any saved receipts belong to this installation; reinstalling
                is not a recovery step.
              </p>
              {snapshot && (
                <details className="identity">
                  <summary>Device identification</summary>
                  <dl>
                    <dt>Installation reference</dt>
                    <dd>{snapshot.identity.installationId}</dd>
                    <dt>Device key fingerprint</dt>
                    <dd>{snapshot.identity.deviceKeySha256}</dd>
                  </dl>
                  <p className="help">
                    For device setup and support. This is not proof of restaurant enrollment.
                  </p>
                </details>
              )}
            </section>
          </div>
          {view === 'receipts' && (
            <section className="history-panel" aria-labelledby="history-heading">
              <h2 id="history-heading">Receipts stored by this app</h2>
              {unavailable ? (
                <p>
                  Open the installed Android app and complete a successful device check to inspect
                  local history.
                </p>
              ) : snapshot.history.receipts.length > 0 ? (
                <>
                  {failed && (
                    <p className="help">
                      Last successful check: {date(snapshot.checkedAt)} Dubai time. Refresh to check
                      for changes.
                    </p>
                  )}
                  <ul className="receipt-list">
                    {snapshot.history.receipts.map((receipt) => (
                      <li key={receipt.id}>
                        <div className="receipt-heading">
                          <strong>{receipt.documentNumber}</strong>
                          <strong>AED {(receipt.totalFils / 100).toFixed(2)}</strong>
                        </div>
                        <p>{date(receipt.issuedAt)} Dubai time</p>
                        <span
                          className={
                            receipt.syncState === 'pending'
                              ? 'receipt-pending'
                              : 'receipt-acknowledged'
                          }
                        >
                          {receipt.syncState === 'pending'
                            ? 'Saved on this device · awaiting sync'
                            : 'Server acknowledged'}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {snapshot.history.hasMore && (
                    <p className="message">
                      Recent receipts are shown. More receipts remain on this device; browsing older
                      records is not available in this app version.
                    </p>
                  )}
                </>
              ) : snapshot.status.receiptCount === 0 && !snapshot.history.hasMore ? (
                <>
                  <p className="empty-title">
                    No receipts were found{failed ? ' at the last successful check' : ''}.
                  </p>
                  <p>
                    This installation has not returned any saved receipts. Sales from the web
                    counter or another device are not included here.
                  </p>
                </>
              ) : (
                <div className="error">
                  <h3>Receipt history needs attention</h3>
                  <p>
                    The device reports saved receipts, but this app version has not returned their
                    documents. Keep the app’s data and contact your manager. Do not record these
                    payments again.
                  </p>
                </div>
              )}
              <p className="help">
                Local receipts and synchronization status are separate. Offline records must remain
                available after setup expires; a connection alone is not proof that they reached the
                server.
              </p>
              <button className="secondary" onClick={() => setView('device')}>
                Back to device status
              </button>
            </section>
          )}
        </main>
      </div>
      <footer>
        Internext POS · Android counter setup
        <span>Offline selling is not enabled in this version.</span>
      </footer>
    </div>
  )
}

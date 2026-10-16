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
} from './native'
import './app.css'

const date = (value: string) =>
  new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Dubai',
  }).format(new Date(value))

function NativeAccess({ available }: { available: boolean }) {
  const [access, setAccess] = useState<NativeAccessState | null>(null)
  const [fresh, setFresh] = useState(false)
  const [busy, setBusy] = useState<'check' | 'signin' | 'signout' | 'enroll' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pendingLogout, setPendingLogout] = useState(false)
  const [branchId, setBranchId] = useState('')
  const [name, setName] = useState('')
  const locked = useRef(false)
  const mounted = useRef(false)
  const apply = useCallback((next: NativeAccessState) => {
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
      if (mounted.current) setBusy(null)
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
    if (!available || locked.current || !fresh || !access) return
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
              : 'Counter enrolled. Offline sales are still paused until offline preparation is available.'
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
  const paused = !!busy || !fresh
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
            disabled={!!busy}
            onClick={() => void check()}
          >
            {busy === 'check' ? 'Checking access…' : 'Check access'}
          </button>
        </>
      )}
      <div className="offline-next">
        <h3>Offline preparation is next</h3>
        <p>
          The bundled app can open without internet. A prepared menu, signed selling permission and
          invoice allocation are still required before it can record sales offline. These are not
          enabled in this version.
        </p>
      </div>
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
                : 'This device has no permission to issue offline sales yet.'}
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

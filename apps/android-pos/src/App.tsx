import { useCallback, useEffect, useRef, useState } from 'react'
import { hasNativeLedger, readDeviceSnapshot, type DeviceSnapshot } from './native'
import './app.css'

const date = (value: string) =>
  new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Dubai',
  }).format(new Date(value))

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
          {view === 'device' ? (
            <div className="device-layout">
              <section className="setup-panel" aria-labelledby="setup-heading">
                <h2 id="setup-heading">Connect to set up your counter</h2>
                <p>
                  Live offline selling requires online enrollment for your restaurant, branch and
                  staff account. Enrollment is not available in this app version.
                </p>
                <ol className="setup-list">
                  <li>
                    <strong>Open the installed app</strong>
                    <span>
                      The bundled app can open without internet. Device checks read local storage.
                    </span>
                  </li>
                  <li>
                    <strong>Enroll this device online</strong>
                    <span>
                      Restaurant access, the menu and permission to issue receipts must be prepared
                      before offline sales.
                    </span>
                  </li>
                  <li>
                    <strong>Verify offline readiness</strong>
                    <span>Sales stay paused until the app confirms that setup is complete.</span>
                  </li>
                </ol>
                <a
                  className="primary external-link"
                  href="https://pos.internext.info/counter"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open online web counter <span aria-hidden="true">↗</span>
                </a>
                <p className="help">
                  Opens separately and requires internet and staff sign-in. Using the web counter
                  does not enroll this Android device.
                </p>
              </section>
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
          ) : (
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
        Internext POS · Device storage foundation
        <span>Offline selling is not enabled in this version.</span>
      </footer>
    </div>
  )
}

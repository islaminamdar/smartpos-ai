'use client'
import Link from 'next/link'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { readPendingRequest } from '@/lib/pos/online-journal'
import { staffAcceptResultSchema } from '@/lib/pos/server/staff'
import styles from './staff.module.css'
import StaffAccessHelp from './StaffAccessHelp'
import StaffAccountSetup from './StaffAccountSetup'
export default function StaffInvitation({ accountSetup = false }: { accountSetup?: boolean }) {
  const [token, setToken] = useState(''),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [accepted, setAccepted] = useState(false)
  const lock = useRef(false),
    incomingToken = useRef<string | null>(null)
  useEffect(() => {
    let mounted = true
    const secret =
      incomingToken.current ?? new URLSearchParams(window.location.hash.slice(1)).get('token') ?? ''
    incomingToken.current = secret
    window.history.replaceState(null, '', window.location.pathname)
    if (!/^[a-f0-9]{64}$/.test(secret)) {
      setError('This invitation link is incomplete. Ask your manager for a new invitation.')
      return
    }
    setToken(secret)
    void (async () => {
      try {
        const response = await fetch('/api/pos/session', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.timeout(15000),
        })
        if (response.status === 401) {
          if (mounted) setReady(true)
          return
        }
        if (!response.ok)
          throw new Error(
            'Your current sign-in could not be checked. Reload from the original invitation link when the service is available.'
          )
        const session = await response.json()
        if (typeof session?.userId !== 'string')
          throw new Error('Your current sign-in could not be verified.')
        if (await readPendingRequest(session.userId))
          throw new Error(
            'This browser has a saved counter request. Return to the counter and resolve it before accepting an invitation, or use your own device.'
          )
        const bootResponse = await fetch('/api/pos/bootstrap', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.timeout(15000),
        })
        if (!bootResponse.ok)
          throw new Error(
            'Current counter access could not be checked. Use your own device to accept this invitation.'
          )
        const boot = await bootResponse.json()
        if (!Array.isArray(boot?.shifts)) throw new Error('Current shifts could not be checked.')
        if (boot.shifts.some((shift: { openedBy?: string }) => shift.openedBy === session.userId))
          throw new Error(
            'This account has an open shift. Close it before changing accounts, or use your own device.'
          )
        if (mounted) setReady(true)
      } catch (cause) {
        if (mounted)
          setError(
            cause instanceof Error
              ? cause.message
              : 'The invitation is not ready. Ask your manager for help.'
          )
      }
    })()
    return () => {
      mounted = false
    }
  }, [])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy || lock.current) return
    const form = event.currentTarget,
      data = new FormData(form)
    const email = String(data.get('email') ?? '').trim(),
      password = String(data.get('password') ?? '')
    lock.current = true
    setBusy(true)
    setError('')
    form.reset()
    try {
      const response = await fetch('/api/pos/staff/invitations/accept', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, email, password }),
        signal: AbortSignal.timeout(20000),
      })
      const result: unknown = await response.json()
      if (!response.ok) {
        const code =
          result && typeof result === 'object' && 'code' in result ? String(result.code) : ''
        if (code === 'sign_out_first')
          throw new Error(
            'This browser is signed in to another account. Return to the original counter, finish its saved work and sign out first, or use your own device.'
          )
        throw new Error(
          response.status === 401
            ? 'Check your email and password. Use the account this invitation was created for.'
            : response.status === 409 || response.status === 410
              ? 'This invitation is no longer available or your access needs review. Ask your manager to check its status.'
              : response.status === 403
                ? 'This account cannot accept this invitation. Use the invited account with a verified email address.'
                : 'Acceptance was not confirmed. Keep this page and try again; do not assume branch access was added.'
        )
      }
      if (!staffAcceptResultSchema.safeParse(result).success)
        throw new Error(
          'Acceptance could not be verified. Keep this page and ask your manager to check the invitation.'
        )
      setAccepted(true)
      setToken('')
      incomingToken.current = ''
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name === 'Error'
          ? cause.message
          : 'Acceptance was not confirmed. Keep this page and try again when connected.'
      )
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return (
    <main className={styles.join}>
      <Link href="/">Internext POS</Link>
      <h1>Accept branch access</h1>
      {accepted ? (
        <div role="status" className={styles.notice}>
          <p>Your branch access has been accepted.</p>
          <Link href="/counter">Open staff counter</Link>
          <p className={styles.help}>Counter enrolment and opening a shift are separate steps.</p>
        </div>
      ) : (
        <>
          <p>
            Sign in using the existing, verified account your manager invited. This does not change
            your password.
          </p>
          {!ready && !error && <p role="status">Checking this browser before you continue…</p>}
          <form onSubmit={submit}>
            <fieldset disabled={!ready || busy} style={{ border: 0, padding: 0, margin: 0 }}>
              <label>
                Invited email
                <input name="email" type="email" autoComplete="username" maxLength={254} required />
              </label>
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  maxLength={256}
                  required
                />
              </label>
              <button className={styles.primary} type="submit">
                {busy ? 'Accepting…' : 'Sign in and accept invitation'}
              </button>
            </fieldset>
          </form>
          {accountSetup ? (
            <StaffAccountSetup
              token={token}
              ready={ready && !busy}
              onBusyChange={setBusy}
              onAccepted={() => {
                setAccepted(true)
                setToken('')
                incomingToken.current = ''
              }}
            />
          ) : (
            <>
              <h2>Need a new account?</h2>
              <p>
                Email verification and password recovery are not enabled yet. Ask your manager or
                administrator to arrange account setup. An invitation link alone cannot activate an
                account.
              </p>
            </>
          )}
          <StaffAccessHelp accountSetup={accountSetup} />
          <Link href="/counter">Back to counter</Link>
        </>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </main>
  )
}

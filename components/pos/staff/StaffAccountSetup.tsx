'use client'
import { useRef, useState, type FormEvent } from 'react'
import { z } from 'zod'
import { staffAcceptResultSchema } from '@/lib/pos/server/staff'
import styles from './staff.module.css'
const requestedSchema = z
  .object({ status: z.literal('setup_requested'), attemptId: z.string().uuid() })
  .strict()
export default function StaffAccountSetup({
  token,
  ready,
  onAccepted,
  onBusyChange,
}: {
  token: string
  ready: boolean
  onAccepted: () => void
  onBusyChange?: (busy: boolean) => void
}) {
  const [attempt, setAttempt] = useState<{ id: string; email: string } | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const lock = useRef(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || lock.current) return
    const form = event.currentTarget,
      data = new FormData(form)
    const email =
      attempt?.email ??
      String(data.get('email') ?? '')
        .trim()
        .toLowerCase()
    const password = String(data.get('password') ?? '')
    if (
      attempt &&
      (password !== data.get('confirmPassword') ||
        password.length < 12 ||
        new TextEncoder().encode(password).length > 72)
    ) {
      setError('Use matching passwords with at least 12 characters and at most 72 bytes.')
      return
    }
    const body = attempt
      ? {
          token,
          email,
          attemptId: attempt.id,
          code: String(data.get('code') ?? '').trim(),
          password,
        }
      : { token, email }
    lock.current = true
    setBusy(true)
    onBusyChange?.(true)
    setError('')
    setNotice('')
    form.reset()
    try {
      const response = await fetch(`/api/pos/staff/setup/${attempt ? 'complete' : 'request'}`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      const result = await response.json()
      if (!response.ok) {
        if (result?.code === 'sign_out_first')
          throw new Error(
            'Use your own signed-out browser for account setup. Finish saved counter work before signing out of a shared device.'
          )
        if (result?.code === 'account_created_access_unconfirmed')
          throw new Error(
            'Your password was set, but branch access was not confirmed. Use Sign in and accept invitation above with your new password; do not request another setup code.'
          )
        if (result?.code === 'account_setup_unconfirmed')
          throw new Error(
            'Password setup was not confirmed. Try signing in above with your chosen password. If that fails, contact your administrator before requesting another code.'
          )
        if (response.status === 429)
          throw new Error(
            'Too many requests or a setup is still processing. Wait at least two minutes before trying again.'
          )
        if (response.status === 401)
          throw new Error(
            'The code is incorrect, expired or already used. Check the latest email. If you submitted a password before, try signing in above with that password before requesting another code.'
          )
        if (response.status === 409)
          throw new Error('This invitation is no longer available. Ask your manager to check it.')
        throw new Error(
          'Account setup was not confirmed. Keep this invitation page. If you already submitted a password, try signing in above before requesting another code.'
        )
      }
      if (!attempt) {
        const resultBody = requestedSchema.parse(result)
        setAttempt({ id: resultBody.attemptId, email })
        setNotice(
          'Setup requested. If this email is eligible for a new account, a verification code has been submitted for delivery. Check your inbox and spam folder. An existing account should sign in above.'
        )
      } else {
        staffAcceptResultSchema.parse(result)
        onAccepted()
      }
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name === 'Error'
          ? cause.message
          : 'The result was not confirmed. If you submitted a password, try signing in above before requesting another code. Keep this page open.'
      )
    } finally {
      lock.current = false
      setBusy(false)
      onBusyChange?.(false)
    }
  }
  return (
    <section aria-labelledby="new-account-title">
      <h2 id="new-account-title">Set up your own account</h2>
      <p>
        Use your invited email. A verification code goes only to your inbox. Do not share the code
        or your password with anyone.
      </p>
      <form onSubmit={submit}>
        <fieldset disabled={!ready || busy} style={{ border: 0, margin: 0, padding: 0 }}>
          {attempt ? (
            <>
              <p>Code requested for {attempt.email}. Use it within 10 minutes.</p>
              <label>
                Email verification code
                <input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6,10}"
                  maxLength={10}
                  required
                />
              </label>
              <label>
                Choose password
                <input
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={72}
                  required
                />
              </label>
              <label>
                Repeat password
                <input
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={72}
                  required
                />
              </label>
              <p className={styles.help}>
                At least 12 characters. Completing setup also accepts your manager’s pending branch
                invitation.
              </p>
            </>
          ) : (
            <label>
              Invited email for new account
              <input name="email" type="email" autoComplete="username" maxLength={254} required />
            </label>
          )}
          <button type="submit" className={styles.primary}>
            {busy
              ? 'Checking…'
              : attempt
                ? 'Verify email, set password and accept'
                : 'Send my verification code'}
          </button>
          {attempt && (
            <button
              type="button"
              onClick={() => {
                setAttempt(null)
                setError('')
                setNotice('')
              }}
            >
              Request a new code
            </button>
          )}
        </fieldset>
      </form>
      {notice && (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </section>
  )
}

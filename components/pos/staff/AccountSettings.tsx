'use client'
import { useRef, useState, type FormEvent } from 'react'
import { passwordChangeSchema } from '@/lib/pos/server/staff'
import styles from './staff.module.css'
export default function AccountSettings({ disabled }: { disabled: boolean }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [changed, setChanged] = useState(false),
    [reveal, setReveal] = useState(false)
  const lock = useRef(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled || lock.current) return
    const form = event.currentTarget,
      data = new FormData(form)
    const currentPassword = String(data.get('currentPassword') ?? ''),
      newPassword = String(data.get('newPassword') ?? '')
    if (newPassword !== data.get('confirmPassword')) {
      setError('The new passwords do not match. Enter the same password twice.')
      return
    }
    if (!passwordChangeSchema.safeParse({ currentPassword, newPassword }).success) {
      setError('Choose a different password with 12–72 characters, using at most 72 bytes.')
      return
    }
    lock.current = true
    setBusy(true)
    setError('')
    form.reset()
    try {
      const response = await fetch('/api/pos/account/password', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
        signal: AbortSignal.timeout(20000),
      })
      const result: unknown = await response.json()
      if (!response.ok) {
        const code =
          result && typeof result === 'object' && 'code' in result ? String(result.code) : ''
        if (code === 'password_changed_sign_out_pending') {
          setChanged(true)
          setError(
            'Your password changed, but signing out other sessions was not confirmed. Sign in with your NEW password; do not submit the old password again.'
          )
          return
        }
        throw new Error(
          response.status === 401
            ? 'The current password could not be verified. Sign in again or check your password.'
            : ['account_open_shifts', 'open_shift', 'staff_open_shifts'].includes(code)
              ? 'Close your open shifts before changing your password.'
              : response.status === 422
                ? 'Check the new password requirements and try again.'
                : 'The password change was not confirmed. Check your connection before trying to sign in again.'
        )
      }
      if (
        !result ||
        typeof result !== 'object' ||
        !('status' in result) ||
        result.status !== 'password_changed' ||
        !('requiresSignIn' in result) ||
        result.requiresSignIn !== true
      )
        throw new Error(
          'The password change could not be verified. Try signing in with your new password; do not assume it changed.'
        )
      setChanged(true)
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name === 'Error'
          ? cause.message
          : 'The password change was not confirmed. Try signing in with your new password; no password has been saved in this browser.'
      )
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  return (
    <section className={styles.account} aria-label="Your account">
      <h2>Change your password</h2>
      <p>
        This changes your sign-in password for this account, including its other branches. You will
        need to sign in again.
      </p>
      {disabled && (
        <p className={styles.notice}>
          Password changes are paused. Close your open shift and resolve any saved counter request
          first.
        </p>
      )}
      {changed ? (
        <div className={styles.notice} role="status">
          <p>Password changed. Sign in again with your new password.</p>
          <a href="/counter">Return to sign in</a>
        </div>
      ) : (
        <form onSubmit={submit}>
          <fieldset disabled={disabled || busy} style={{ border: 0, padding: 0, margin: 0 }}>
            <label>
              Current password
              <input
                name="currentPassword"
                type={reveal ? 'text' : 'password'}
                autoComplete="current-password"
                required
                maxLength={256}
              />
            </label>
            <label>
              New password
              <input
                name="newPassword"
                type={reveal ? 'text' : 'password'}
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={72}
              />
            </label>
            <label>
              Confirm new password
              <input
                name="confirmPassword"
                type={reveal ? 'text' : 'password'}
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={72}
              />
            </label>
            <p className={styles.help}>
              Use 12–72 characters (at most 72 bytes). Finish saved counter requests and close your
              shifts first.
            </p>
            <div className={styles.actions}>
              <button type="button" aria-pressed={reveal} onClick={() => setReveal(!reveal)}>
                {reveal ? 'Hide passwords' : 'Show passwords'}
              </button>
              <button className={styles.primary} type="submit">
                {busy ? 'Changing password…' : 'Change password'}
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <p className={styles.help}>
        Forgot your password? Email recovery is not enabled yet. Contact your administrator for
        setup assistance. Managers cannot see or reset your password here.
      </p>
    </section>
  )
}

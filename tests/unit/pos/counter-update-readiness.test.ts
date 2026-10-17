import { describe, expect, it } from 'vitest'
import { counterUpdateReady, type CounterUpdateState } from '@/lib/pos/counter-update-readiness'

const idle: CounterUpdateState = {
  loading: false,
  online: true,
  needsLogin: false,
  authenticated: true,
  hasSessionHistory: true,
  guardedSignedOut: false,
  busy: false,
  knownPending: false,
  unsavedWork: false,
  idleCounter: true,
  checksReady: true,
  shiftOpen: false,
}

describe('Android update handoff', () => {
  it('allows an idle authenticated counter only after its shift is closed', () => {
    expect(counterUpdateReady(idle)).toBe(true)
    expect(counterUpdateReady({ ...idle, shiftOpen: true })).toBe(false)
  })

  it.each([
    { loading: true },
    { online: false },
    { busy: true },
    { knownPending: true },
    { unsavedWork: true },
    { idleCounter: false },
    { checksReady: false },
    { authenticated: false },
  ])('blocks unsafe or unknown counter state: %j', (state) => {
    expect(counterUpdateReady({ ...idle, ...state })).toBe(false)
  })

  const freshLogin = {
    ...idle,
    needsLogin: true,
    authenticated: false,
    hasSessionHistory: false,
    checksReady: false,
  }
  it('allows an idle fresh login without requiring account-scoped journal reads', () => {
    expect(counterUpdateReady(freshLogin)).toBe(true)
  })
  it('blocks a session-expiry screen and permits only a completed guarded signout', () => {
    const expired = { ...freshLogin, hasSessionHistory: true }
    expect(counterUpdateReady(expired)).toBe(false)
    expect(counterUpdateReady({ ...expired, guardedSignedOut: true })).toBe(true)
    expect(counterUpdateReady({ ...expired, guardedSignedOut: true, authenticated: true })).toBe(
      false
    )
  })
  it.each([
    { busy: true },
    { knownPending: true },
    { unsavedWork: true },
    { loading: true },
    { online: false },
  ])('never lets a login screen bypass live operation blockers: %j', (state) => {
    expect(counterUpdateReady({ ...freshLogin, ...state })).toBe(false)
    expect(counterUpdateReady({ ...freshLogin, ...state, guardedSignedOut: true })).toBe(false)
  })
})

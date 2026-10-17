/** Read-only handoff to the Android installer; it never authorises a sale or clears storage. */
export type CounterUpdateState = {
  loading: boolean
  online: boolean
  needsLogin: boolean
  authenticated: boolean
  hasSessionHistory: boolean
  guardedSignedOut: boolean
  busy: boolean
  knownPending: boolean
  unsavedWork: boolean
  idleCounter: boolean
  checksReady: boolean
  shiftOpen: boolean
}

export function counterUpdateReady(state: CounterUpdateState): boolean {
  if (state.loading || !state.online || state.busy || state.knownPending || state.unsavedWork)
    return false
  // A new login screen has no live operation to interrupt. Persistent recovery journals
  // survive a same-package Android upgrade. An expired session from this screen does
  // not qualify: its owner must recover/sign out through the existing guarded flow.
  if (state.needsLogin)
    return !state.authenticated && (!state.hasSessionHistory || state.guardedSignedOut)
  return state.authenticated && state.idleCounter && state.checksReady && !state.shiftOpen
}

/**
 * Older Android System WebViews do not expose AbortSignal.timeout/any. The counter
 * must still reach the server and show the staff sign-in screen on those devices.
 * Keep the native implementation where it exists; this only fills the gaps.
 */
type AbortSignalWithCompatibility = typeof AbortSignal & {
  timeout?: (milliseconds: number) => AbortSignal
  any?: (signals: AbortSignal[]) => AbortSignal
}

export function installBrowserAbortSignalCompatibility(
  compatibleAbortSignal: AbortSignalWithCompatibility
) {
  if (typeof compatibleAbortSignal.timeout !== 'function') {
    compatibleAbortSignal.timeout = (milliseconds: number) => {
      const controller = new AbortController()
      globalThis.setTimeout(() => controller.abort(), milliseconds)
      return controller.signal
    }
  }

  if (typeof compatibleAbortSignal.any !== 'function') {
    compatibleAbortSignal.any = (signals: AbortSignal[]) => {
      const controller = new AbortController()
      const abort = () => controller.abort()
      for (const signal of signals) {
        if (signal.aborted) {
          abort()
          break
        }
        signal.addEventListener('abort', abort, { once: true })
      }
      return controller.signal
    }
  }
}

installBrowserAbortSignalCompatibility(AbortSignal as AbortSignalWithCompatibility)
installBrowserUuidCompatibility(globalThis.crypto)
import { installBrowserUuidCompatibility } from './browser-uuid'

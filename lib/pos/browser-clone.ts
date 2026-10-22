/**
 * Clone the JSON-compatible command records kept in browser storage.
 * Android System WebView did not ship structuredClone until much later than
 * IndexedDB, so counter commands must not rely on it being available.
 */
export function browserClone<T>(value: T, nativeClone = globalThis.structuredClone): T {
  if (typeof nativeClone === 'function') return nativeClone(value)
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('This browser cannot safely copy the counter record.')
  return JSON.parse(encoded) as T
}

/** Lets older feature modules using the platform name continue to work. */
export function installBrowserCloneCompatibility(target: typeof globalThis = globalThis) {
  if (typeof target.structuredClone === 'function') return
  try {
    Object.defineProperty(target, 'structuredClone', {
      configurable: true,
      value: <T>(value: T) => browserClone(value, undefined),
    })
  } catch {
    // Critical counter paths call browserClone directly.
  }
}

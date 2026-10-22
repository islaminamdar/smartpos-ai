/**
 * Clone the JSON-compatible command records kept in browser storage.
 * Android System WebView did not ship structuredClone until much later than
 * IndexedDB, so counter commands must not rely on it being available.
 */
export function browserClone<T>(value: T, nativeClone?: typeof globalThis.structuredClone): T {
  const clone = arguments.length > 1 ? nativeClone : globalThis.structuredClone
  if (typeof clone === 'function') return clone(value)
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('This browser cannot safely copy the counter record.')
  return JSON.parse(encoded) as T
}

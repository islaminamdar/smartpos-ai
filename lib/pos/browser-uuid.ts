type BrowserCrypto = Pick<Crypto, 'getRandomValues'> & { randomUUID?: () => string }

function uuidFromBytes(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function fallbackUuid(secureCrypto: BrowserCrypto): string {
  if (typeof secureCrypto.getRandomValues !== 'function')
    throw new Error('Secure random IDs require HTTPS and a supported browser.')
  return uuidFromBytes(secureCrypto.getRandomValues(new Uint8Array(16)))
}

/** Secure UUID v4 for older Android WebViews which lack crypto.randomUUID(). */
export function browserUuid(secureCrypto: BrowserCrypto | undefined = globalThis.crypto): string {
  if (typeof secureCrypto?.randomUUID === 'function') return secureCrypto.randomUUID()
  if (!secureCrypto) throw new Error('Secure random IDs require HTTPS and a supported browser.')
  return fallbackUuid(secureCrypto)
}

export function installBrowserUuidCompatibility(secureCrypto: BrowserCrypto | undefined) {
  if (!secureCrypto || typeof secureCrypto.randomUUID === 'function') return
  if (typeof secureCrypto.getRandomValues !== 'function') return
  try {
    Object.defineProperty(secureCrypto, 'randomUUID', {
      configurable: true,
      value: () => fallbackUuid(secureCrypto),
    })
  } catch {
    // Direct callers use browserUuid(); leave an immutable host object untouched.
  }
}

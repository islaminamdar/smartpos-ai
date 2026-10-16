import { MAX_SIGNED_PAYLOAD_BYTES } from './contracts'

function validString(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (c >= 0xdc00 && c <= 0xdfff) return false
  }
  return true
}

/** Restricted protocol JSON, not a general-purpose RFC8785 implementation. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>()
  function encode(node: unknown, depth: number): string {
    if (depth > 32) throw new Error('Payload nesting is too deep.')
    if (node === null || typeof node === 'boolean') return JSON.stringify(node)
    if (typeof node === 'number') {
      if (!Number.isSafeInteger(node) || Object.is(node, -0)) throw new Error('Only safe integers are allowed.')
      return String(node)
    }
    if (typeof node === 'string') {
      if (!validString(node)) throw new Error('Invalid Unicode string.')
      return JSON.stringify(node)
    }
    if (typeof node !== 'object' || ancestors.has(node)) throw new Error('Invalid JSON value.')
    if (!Array.isArray(node) && Object.getPrototypeOf(node) !== Object.prototype && Object.getPrototypeOf(node) !== null)
      throw new Error('Only plain JSON objects are allowed.')
    ancestors.add(node)
    let result: string
    if (Array.isArray(node)) {
      const values: string[] = []
      for (let i = 0; i < node.length; i++) {
        if (!Object.hasOwn(node, i)) throw new Error('Sparse arrays are not allowed.')
        values.push(encode(node[i], depth + 1))
      }
      result = '[' + values.join(',') + ']'
    } else {
      if (Object.getOwnPropertySymbols(node).length) throw new Error('Symbol keys are not allowed.')
      result = '{' + Object.keys(node).sort().map((key) => {
        if (!validString(key)) throw new Error('Invalid Unicode key.')
        const descriptor = Object.getOwnPropertyDescriptor(node, key)
        if (!descriptor || !('value' in descriptor)) throw new Error('Accessors are not allowed.')
        return JSON.stringify(key) + ':' + encode(descriptor.value, depth + 1)
      }).join(',') + '}'
    }
    ancestors.delete(node)
    return result
  }
  const result = encode(value, 0)
  if (new TextEncoder().encode(result).length > MAX_SIGNED_PAYLOAD_BYTES) throw new Error('Payload exceeds the size limit.')
  return result
}

export function canonicalBytes(value: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(canonicalJson(value))
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeBase64Url(value: string, maxBytes = MAX_SIGNED_PAYLOAD_BYTES): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1 || value.length > Math.ceil(maxBytes * 4 / 3))
    throw new Error('Invalid or oversized base64url.')
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  if (bytes.length > maxBytes || encodeBase64Url(bytes) !== value) throw new Error('Noncanonical base64url.')
  return bytes
}

export function parseCanonicalPayload(bytes: Uint8Array): unknown {
  if (bytes.length > MAX_SIGNED_PAYLOAD_BYTES) throw new Error('Payload exceeds the size limit.')
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  const parsed: unknown = JSON.parse(text)
  if (canonicalJson(parsed) !== text) throw new Error('Payload is not canonical JSON.')
  return parsed
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

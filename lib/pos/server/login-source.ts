import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { PosServerError } from './client'

// Enable only when the sole inbound proxy appends its verified peer as the final XFF value.
// Never choose the caller-controlled leftmost value. This is a rate-limit key, not identity.
export function loginSourceKey(request: Request) {
  const mode = process.env.POS_LOGIN_SOURCE_MODE
  if (mode === 'loopback-development') {
    let origin: URL
    try {
      origin = new URL(process.env.POS_PUBLIC_ORIGIN ?? '')
    } catch {
      throw new PosServerError('login_source_unavailable', 503)
    }
    // NextURL normalizes literal loopback addresses to localhost. Require both
    // hosts to be loopback and preserve the protocol/port boundary.
    const actual = new URL(request.url)
    const loopback = ['127.0.0.1', 'localhost', '[::1]']
    if (
      !loopback.includes(origin.hostname) ||
      !loopback.includes(actual.hostname) ||
      actual.protocol !== origin.protocol ||
      actual.port !== origin.port
    )
      throw new PosServerError('login_source_unavailable', 503)
    return hash('development-loopback')
  }
  if (mode !== 'apache-rightmost') throw new PosServerError('login_source_unavailable', 503)
  const forwarded = request.headers.get('x-forwarded-for')
  if (!forwarded || forwarded.length > 8192)
    throw new PosServerError('login_source_unavailable', 503)
  const address = forwarded.split(',').at(-1)?.trim() ?? ''
  const family = isIP(address)
  if (!family) throw new PosServerError('login_source_unavailable', 503)
  if (family === 4) return hash('ipv4:' + address)
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1)
  const [left, right] = normalized.split('::')
  const leading = left ? left.split(':') : [],
    trailing = right ? right.split(':') : []
  const parts =
    right !== undefined
      ? [...leading, ...Array(8 - leading.length - trailing.length).fill('0'), ...trailing]
      : leading
  if (parts.length !== 8) throw new PosServerError('login_source_unavailable', 503)
  const values = parts.map((part) => Number.parseInt(part, 16))
  if (values.slice(0, 5).every((value) => value === 0) && values[5] === 65535) {
    return hash(
      'ipv4:' + [values[6] >> 8, values[6] & 255, values[7] >> 8, values[7] & 255].join('.')
    )
  }
  // One IPv6 /64 shares a budget, preventing inexpensive per-address rotation.
  return hash(
    'ipv6:' +
      values
        .slice(0, 4)
        .map((value) => value.toString(16))
        .join(':')
  )
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

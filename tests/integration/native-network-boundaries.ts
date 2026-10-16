import assert from 'node:assert/strict'
import { request } from 'node:https'

interface Device {
  actorId: string
  deviceId: string
  accessToken: string
  deviceToken: string
}
interface Configuration { port: number; ca: string | Buffer; devices: Device[]; branchId: string }

/** Independent network preflight. All mutation requests must fail before custody changes. */
export async function verifyNativeNetworkBoundaries(config: Configuration) {
  assert.equal(config.devices.length, 2)
  assert.ok(config.port >= 1024 && config.port <= 65535)
  const checks: string[] = []
  const cookie = (device: Device, binding = device.deviceToken) =>
    `pos-access=${device.accessToken}; pos-device-${device.actorId}=${binding}`
  function send(path: string, body?: string, headers: Record<string, string> = {}, trust = true) {
    return new Promise<{ status: number; body: Record<string, unknown>; cache: string | undefined }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: config.port, path,
        method: body === undefined ? 'GET' : 'POST', ...(trust ? { ca: config.ca } : {}),
        rejectUnauthorized: true, headers: { Origin: 'https://pos.internext.info',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) }), ...headers },
      }, response => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 131_072) response.destroy(new Error('Oversized preflight response'))
          else chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () => {
          try { resolve({ status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')), cache: response.headers['cache-control'] }) }
          catch (error) { reject(error) }
        })
      })
      req.setTimeout(10_000, () => req.destroy(new Error('Preflight request timed out')))
      req.on('error', reject)
      req.end(body)
    })
  }
  await assert.rejects(send('/api/pos/native/access', undefined, {}, false),
    (error: Error & { code?: string }) => ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(error.code ?? ''))
  checks.push('untrusted TLS certificate rejected')

  const unauthenticatedHeaders: Record<string, string>[] = [{}, { Cookie: 'pos-access=unrecognised-test-token' }]
  for (const headers of unauthenticatedHeaders) {
    const result = await send('/api/pos/native/access', undefined, headers)
    assert.equal(result.status, 401)
    assert.equal(result.body.code, 'authentication_required')
    assert.equal(result.cache, 'private, no-store')
  }
  checks.push('missing and invalid session denied')
  for (const device of config.devices) {
    const result = await send('/api/pos/native/access', undefined, { Cookie: cookie(device) })
    assert.equal(result.status, 200)
    assert.equal(result.body.actorId, device.actorId)
    assert.equal((result.body.device as Record<string, unknown>).id, device.deviceId)
    assert.equal(result.cache, 'private, no-store')
  }
  checks.push('each session sees its own bound counter')

  const [first, second] = config.devices
  const context = JSON.stringify({ challenge: 'c'.repeat(64), branchId: config.branchId, deviceId: first.deviceId })
  const rejectedOrigins: Record<string, string>[] = [{ Origin: 'https://invalid.example.test' }, { 'Sec-Fetch-Site': 'cross-site' }]
  for (const headers of rejectedOrigins) {
    const result = await send('/api/pos/native/preparation', context, { Cookie: cookie(first), ...headers })
    assert.equal(result.status, 403)
    assert.equal(result.body.code, 'origin_rejected')
  }
  checks.push('wrong origin and cross-site requests denied')
  for (const headers of [{ Cookie: `pos-access=${first.accessToken}` }, { Cookie: cookie(first, second.deviceToken) }, { Cookie: cookie(second) }]) {
    const result = await send('/api/pos/native/preparation', context, headers)
    assert.equal(result.status, 403)
    assert.equal(result.body.code, 'device_binding_required')
  }
  checks.push('missing binding, other actor binding and cross-counter scope denied')
  for (const [body, status, code] of [
    ['{', 400, 'invalid_json'],
    ['{}', 422, 'invalid_offline_request'],
    [JSON.stringify({ ...JSON.parse(context), untrusted: true }), 422, 'invalid_offline_request'],
    [' '.repeat(1025), 413, 'payload_too_large'],
  ] as const) {
    const result = await send('/api/pos/native/preparation', body, { Cookie: cookie(first) })
    assert.equal(result.status, status)
    assert.equal(result.body.code, code)
    assert.equal(result.cache, 'private, no-store')
  }
  checks.push('JSON, strict schema and request byte limits enforced')
  return { checks }
}

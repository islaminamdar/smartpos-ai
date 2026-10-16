// @vitest-environment node
import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { verifySignedEnvelope } from '@/lib/pos/offline/authority'
import { importOfflinePublicKey } from '@/lib/pos/offline/server-keys'
import {
  nativeClockBootstrapRequestSchema,
  nativeClockBootstrapTimeSchema,
} from '@/lib/pos/offline/native-clock-bootstrap'
import { canonicalJson, parseCanonicalPayload } from '@/lib/pos/offline/canonical'

it('verifies the real server fixture shared with the Java verifier without a private key', async () => {
  const fixture = JSON.parse(
    await readFile(
      'apps/android-pos/android/app/src/test/resources/native-clock-bootstrap-server-output.json',
      'utf8'
    )
  )
  expect(Object.keys(fixture).sort()).toEqual(['request', 'serverPublicKeySpki', 'time'])
  const request = nativeClockBootstrapRequestSchema.parse(fixture.request)
  const key = await importOfflinePublicKey(fixture.serverPublicKeySpki)
  const verified = await verifySignedEnvelope(fixture.time, nativeClockBootstrapTimeSchema, {
    'bootstrap-interop': key,
  })
  expect(verified.payload).toEqual({
    ...request,
    kind: 'native-clock-bootstrap-time',
    serverTimeMs: expect.any(Number),
  })
})

it('accepts captured Android HTTPS bytes and verifies the Android fixture signature with the server parser', async () => {
  const fixture = JSON.parse(
    await readFile('tests/unit/pos/fixtures/native-clock-bootstrap-android-output.json', 'utf8')
  )
  const wire = new TextEncoder().encode(fixture.canonicalRequest)
  expect(wire.byteLength).toBeLessThanOrEqual(2048)
  expect(fixture.canonicalRequest).toBe(canonicalJson(fixture.request))
  const request = nativeClockBootstrapRequestSchema.parse(parseCanonicalPayload(wire))
  expect(request).toEqual(fixture.request)
  const key = await importOfflinePublicKey(fixture.serverPublicKeySpki)
  const result = await verifySignedEnvelope(fixture.time, nativeClockBootstrapTimeSchema, {
    'synthetic-server': key,
  })
  expect(result.payload).toEqual({
    ...request,
    kind: 'native-clock-bootstrap-time',
    serverTimeMs: expect.any(Number),
  })
})

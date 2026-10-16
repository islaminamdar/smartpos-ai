// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import fixture from '../../../fixtures/offline-signed-protocol.json'
import { decodeBase64Url } from '@/lib/pos/offline/canonical'
import { publicKeyFingerprint, verifySignedEnvelope } from '@/lib/pos/offline/authority'

describe('shared native and server signature vectors', () => {
  it('uses identical P256 fingerprints, canonical payload hashes and rejection decisions', async () => {
    const key = await crypto.subtle.importKey('spki', decodeBase64Url(fixture.publicKeyBase64Url),
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
    expect(await publicKeyFingerprint(key)).toBe(fixture.fingerprint)
    for (const row of fixture.cases) {
      const verification = verifySignedEnvelope(row.envelope, z.unknown(), { 'synthetic-node-v1': key })
      if (row.valid) expect((await verification).payloadSha256).toBe(row.payloadSha256)
      else await expect(verification).rejects.toThrow()
    }
  })
})

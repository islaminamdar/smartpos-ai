// @vitest-environment node
import { expect, it } from 'vitest'
import fixture from '../../../fixtures/pos-offline-output.json'
import { offlineAuthoritySchema, offlineSnapshotSchema, signedEnvelopeSchema } from '@/lib/pos/offline/contracts'
import { canonicalBytes, decodeBase64Url, parseCanonicalPayload, sha256Hex } from '@/lib/pos/offline/canonical'
import { enrollmentResultSchema, offlineAckSchema, offlineExceptionSchema } from '@/lib/pos/offline/server-contracts'
import { validateHistoricalIssuance } from '@/lib/pos/offline/validation'

// This fixture comes from actual isolated SQL. Its synthetic signature/SPKI bytes
// deliberately do not attest crypto: application integration tests own that boundary.
it('accepts actual SQL frozen bundle fields and hashes without rewriting timestamps or merchant data', async () => {
  const snapshot = offlineSnapshotSchema.parse(fixture.bundle.snapshot)
  const authority = offlineAuthoritySchema.parse(fixture.bundle.authority)
  expect(enrollmentResultSchema.parse(fixture.enrollment).keyEpoch).toBe(authority.keyEpoch)
  expect(await sha256Hex(canonicalBytes(snapshot))).toBe(fixture.bundle.snapshotSha256)
  expect(await sha256Hex(canonicalBytes(authority))).toBe(fixture.bundle.authoritySha256)
  expect(parseCanonicalPayload(decodeBase64Url(fixture.bundle.snapshotEnvelope.payloadBase64Url))).toEqual(snapshot)
  expect(parseCanonicalPayload(decodeBase64Url(fixture.bundle.authorityEnvelope.payloadBase64Url))).toEqual(authority)
  expect(fixture.reservation.authority.snapshotSha256).toBeNull()
})

it('independently validates the exact historical receipt accepted by SQL against its original snapshot', () => {
  const result = validateHistoricalIssuance(fixture.issuance, {
    snapshot: offlineSnapshotSchema.parse(fixture.bundle.snapshot),
    authority: offlineAuthoritySchema.parse(fixture.bundle.authority),
    snapshotSha256: fixture.bundle.snapshotSha256,
    authoritySha256: fixture.bundle.authoritySha256,
  })
  expect(result.issuance.document).toEqual(fixture.imported.receipt)
  expect(result).toMatchObject({ grossFils: 1000, netFils: 952, taxFils: 48, invoiceSequence: 1 })
})

it('preserves the original SQL custody ACK on retry and keeps rejection separate from accepted payment', async () => {
  const envelope = signedEnvelopeSchema.parse(fixture.imported.acknowledgement)
  const ack = offlineAckSchema.parse(parseCanonicalPayload(decodeBase64Url(envelope.payloadBase64Url)))
  expect(ack.issuanceId).toBe(fixture.issuance.id)
  expect(ack.payloadSha256).toBe(await sha256Hex(canonicalBytes(fixture.issuance)))
  expect(fixture.replayed.acknowledgement).toEqual(envelope)
  expect(fixture.replayed.replayed).toBe(true)
  expect(offlineExceptionSchema.parse(fixture.reconciliation).status).toBe('reconciliation_required')
})

import { z } from 'zod'
import { posClient, PosServerError } from '../server/client'
import { assertBundleScope, publicKeyFingerprint, signEnvelope, verifyOfflineBundle, verifySignedEnvelope } from './authority'
import { canonicalBytes, canonicalJson, decodeBase64Url, parseCanonicalPayload, sha256Hex } from './canonical'
import { offlineAuthoritySchema, offlineSnapshotSchema, signedEnvelopeSchema } from './contracts'
import { offlineUuid } from './server-contracts'
import { importOfflinePublicKey, offlineServerKeys, type OfflineServerKeys } from './server-keys'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const offlineBundleRecoveryProofSchema = z.object({ kind: z.literal('offline-bundle-recovery'), schemaVersion: z.literal(1),
  authorityId: offlineUuid, keyEpoch: offlineUuid, deviceId: offlineUuid, challenge: hash }).strict()
export const nativeOfflineRecoveredSchema = z.object({ kind: z.literal('native-offline-recovered'), schemaVersion: z.literal(1),
  purpose: z.literal('reconciliation-only'), challenge: hash, serverTimeMs: z.number().int().nonnegative().max(253_402_300_799_999),
  actorId: offlineUuid, organizationId: offlineUuid, branchId: offlineUuid, deviceId: offlineUuid, shiftId: offlineUuid,
  keyEpoch: offlineUuid, deviceKeySha256: hash, authorityId: offlineUuid, snapshotSha256: hash, authoritySha256: hash }).strict()
const readerSchema = z.object({ snapshot: offlineSnapshotSchema, authority: z.record(z.unknown()),
  snapshotEnvelope: signedEnvelopeSchema.nullable(), authorityEnvelope: signedEnvelopeSchema.nullable(),
  snapshotSha256: hash.nullable(), authoritySha256: hash.nullable(), publicKeySpki: z.string().max(342),
  keyEpoch: offlineUuid, deviceId: offlineUuid }).strict()

async function rpc(name: 'pos_offline_authority' | 'pos_offline_attach', args: Record<string, unknown>) {
  const { data, error } = await posClient(undefined, true).rpc(name, args)
  if (error) throw new PosServerError('offline_storage_unavailable', 503)
  return data
}

/** Authenticate stored scope even if the original signing/attachment was interrupted. */
async function history(raw: unknown, keys: OfflineServerKeys) {
  try {
    const row = readerSchema.parse(raw)
    // This transport row contains both decoded payloads and base64 envelopes, so it can
    // exceed a single signed-payload budget. Reject normalization per decoded payload.
    const original = raw as Record<string, unknown>
    if (canonicalJson(row.snapshot) !== canonicalJson(original.snapshot) || canonicalJson(row.authority) !== canonicalJson(original.authority)) throw new Error()
    const attached = row.snapshotEnvelope !== null
    if ([row.authorityEnvelope, row.snapshotSha256, row.authoritySha256].some(value => (value !== null) !== attached)) throw new Error()
    const snapshotSha256 = await sha256Hex(canonicalBytes(row.snapshot))
    if (!attached && row.authority.snapshotSha256 !== null) throw new Error()
    const authority = offlineAuthoritySchema.parse(attached ? row.authority : { ...row.authority, snapshotSha256 })
    assertBundleScope(row.snapshot, authority, snapshotSha256)
    const authoritySha256 = await sha256Hex(canonicalBytes(authority)), deviceKey = await importOfflinePublicKey(row.publicKeySpki)
    if (row.keyEpoch !== authority.keyEpoch || row.deviceId !== authority.deviceId || await publicKeyFingerprint(deviceKey) !== authority.deviceKeySha256) throw new Error()
    if (attached) {
      const bundle = await verifyOfflineBundle(row.snapshotEnvelope, row.authorityEnvelope, keys.publicKeys)
      if (canonicalJson(bundle.snapshot) !== canonicalJson(row.snapshot) || canonicalJson(bundle.authority) !== canonicalJson(authority) ||
        row.snapshotSha256 !== snapshotSha256 || row.authoritySha256 !== authoritySha256 || bundle.snapshotSha256 !== snapshotSha256 || bundle.authoritySha256 !== authoritySha256) throw new Error()
    }
    return { row, authority, snapshotSha256, authoritySha256, deviceKey, attached }
  } catch { throw new PosServerError('offline_storage_unavailable', 503) }
}

/** Historical device custody only. This never reserves numbers, renews a grant, or checks
 * current login/branch eligibility. Its distinct signed purpose cannot authorize selling. */
export async function recoverOfflineBundle(raw: unknown) {
  const envelope = signedEnvelopeSchema.parse(raw)
  const proof = offlineBundleRecoveryProofSchema.parse(parseCanonicalPayload(decodeBase64Url(envelope.payloadBase64Url)))
  const keys = await offlineServerKeys(), stored = await rpc('pos_offline_authority', { p_id: proof.authorityId })
  if (!stored) throw new PosServerError('offline_authority_unavailable', 404)
  const original = await history(stored, keys)
  try {
    await verifySignedEnvelope(envelope, offlineBundleRecoveryProofSchema, { [original.authority.deviceKeySha256]: original.deviceKey })
    if (proof.authorityId !== original.authority.id || proof.keyEpoch !== original.authority.keyEpoch || proof.deviceId !== original.authority.deviceId) throw new Error()
  } catch { throw new PosServerError('offline_device_proof_invalid', 403) }
  let recovered = original
  if (!original.attached) {
    // Finish ONLY the pre-existing immutable reservation after possession proof. The SQL
    // attach RPC compares exact frozen payloads and returns its first stored signatures.
    const snapshotEnvelope = await signEnvelope(original.row.snapshot, keys.activeId, keys.privateKey)
    const authorityEnvelope = await signEnvelope(original.authority, keys.activeId, keys.privateKey)
    recovered = await history(await rpc('pos_offline_attach', { p_authority: proof.authorityId,
      p_snapshot_envelope: snapshotEnvelope, p_authority_envelope: authorityEnvelope }), keys)
    if (!recovered.attached || canonicalJson(recovered.row.snapshot) !== canonicalJson(original.row.snapshot) ||
      canonicalJson(recovered.authority) !== canonicalJson(original.authority) || recovered.row.publicKeySpki !== original.row.publicKeySpki)
      throw new PosServerError('offline_storage_unavailable', 503)
  }
  const a = recovered.authority
  const handoff = nativeOfflineRecoveredSchema.parse({ kind: 'native-offline-recovered', schemaVersion: 1, purpose: 'reconciliation-only',
    challenge: proof.challenge, serverTimeMs: Date.now(), actorId: a.actorId, organizationId: a.organizationId, branchId: a.branchId,
    deviceId: a.deviceId, shiftId: a.shiftId, keyEpoch: a.keyEpoch, deviceKeySha256: a.deviceKeySha256, authorityId: a.id,
    snapshotSha256: recovered.snapshotSha256, authoritySha256: recovered.authoritySha256 })
  return { snapshotEnvelope: recovered.row.snapshotEnvelope!, authorityEnvelope: recovered.row.authorityEnvelope!,
    handoff: await signEnvelope(handoff, keys.activeId, keys.privateKey) }
}

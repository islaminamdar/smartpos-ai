import type { z } from 'zod'
import {
  signedEnvelopeSchema, offlineAuthoritySchema, offlineSnapshotSchema, offlineIssuanceSchema,
  type SignedEnvelope, type OfflineAuthority, type OfflineSnapshot, type OfflineIssuance,
} from './contracts'
import { canonicalBytes, canonicalJson, decodeBase64Url, encodeBase64Url, parseCanonicalPayload, sha256Hex } from './canonical'

const curveOrder = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')

function scalarValue(bytes: Uint8Array): bigint {
  return BigInt('0x' + Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''))
}

/** Strict DER, including minimal positive scalar encoding. WebCrypto uses raw r||s. */
export function derToP1363(signature: Uint8Array): Uint8Array<ArrayBuffer> {
  if (signature.length < 8 || signature.length > 72 || signature[0] !== 0x30 || signature[1] !== signature.length - 2)
    throw new Error('Invalid DER signature.')
  let offset = 2
  const result = new Uint8Array(64)
  for (let component = 0; component < 2; component++) {
    if (signature[offset++] !== 0x02) throw new Error('Invalid DER integer.')
    const length = signature[offset++]
    if (length < 1 || length > 33 || offset + length > signature.length) throw new Error('Invalid DER integer length.')
    let integer = signature.slice(offset, offset + length)
    offset += length
    if ((integer[0] & 0x80) || (length > 1 && integer[0] === 0 && !(integer[1] & 0x80)))
      throw new Error('Nonminimal or negative DER integer.')
    if (integer[0] === 0) integer = integer.slice(1)
    if (!integer.length || integer.length > 32) throw new Error('Invalid signature scalar.')
    const value = scalarValue(integer)
    if (value === BigInt(0) || value >= curveOrder) throw new Error('Signature scalar out of range.')
    result.set(integer, component * 32 + 32 - integer.length)
  }
  if (offset !== signature.length) throw new Error('Trailing DER data.')
  return result
}

export function p1363ToDer(signature: Uint8Array): Uint8Array<ArrayBuffer> {
  if (signature.length !== 64) throw new Error('Invalid P1363 signature.')
  const parts: number[] = []
  for (let start = 0; start < 64; start += 32) {
    let integer = signature.slice(start, start + 32)
    const value = scalarValue(integer)
    if (value === BigInt(0) || value >= curveOrder) throw new Error('Signature scalar out of range.')
    while (integer.length > 1 && integer[0] === 0) integer = integer.slice(1)
    if (integer[0] & 0x80) parts.push(2, integer.length + 1, 0, ...integer)
    else parts.push(2, integer.length, ...integer)
  }
  return Uint8Array.from([0x30, parts.length, ...parts])
}

function assertP256(key: CryptoKey, usage: 'sign' | 'verify'): void {
  if (key.algorithm.name !== 'ECDSA' || (key.algorithm as EcKeyAlgorithm).namedCurve !== 'P-256' || !key.usages.includes(usage))
    throw new Error('A trusted P-256 signing key is required.')
}

/** Caller supplies trusted keys independently; envelope fields never authorize a key. */
export async function verifySignedEnvelope<T>(
  raw: unknown, schema: z.ZodType<T>, trustedKeys: Readonly<Record<string, CryptoKey>>,
): Promise<{ payload: T; payloadSha256: string }> {
  const envelope = signedEnvelopeSchema.parse(raw)
  if (!Object.hasOwn(trustedKeys, envelope.keyId)) throw new Error('Unknown signing key.')
  const key = trustedKeys[envelope.keyId]
  assertP256(key, 'verify')
  const bytes = decodeBase64Url(envelope.payloadBase64Url)
  const signature = derToP1363(decodeBase64Url(envelope.signatureBase64Url, 72))
  if (!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, bytes)))
    throw new Error('Signature verification failed.')
  const parsed = parseCanonicalPayload(bytes)
  const payload = schema.parse(parsed)
  // Zod transformations must never silently alter authenticated financial bytes.
  if (canonicalJson(payload) !== canonicalJson(parsed)) throw new Error('Payload schema normalization would change signed data.')
  return { payload, payloadSha256: await sha256Hex(bytes) }
}

/** Protocol helper only. Production authority keys belong exclusively on the server. */
export async function signEnvelope(payload: unknown, keyId: string, privateKey: CryptoKey): Promise<SignedEnvelope> {
  assertP256(privateKey, 'sign')
  const bytes = canonicalBytes(payload)
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, bytes))
  return signedEnvelopeSchema.parse({ format: 'pos-signed-v1', alg: 'ECDSA-P256-SHA256-DER', keyId,
    payloadBase64Url: encodeBase64Url(bytes), signatureBase64Url: encodeBase64Url(p1363ToDer(signature)) })
}

export function assertBundleScope(snapshot: OfflineSnapshot, grant: OfflineAuthority, snapshotSha256: string): void {
  if (grant.snapshotId !== snapshot.id || grant.snapshotSha256 !== snapshotSha256 ||
    grant.organizationId !== snapshot.organizationId || grant.branchId !== snapshot.branchId)
    throw new Error('Authority and catalogue snapshot do not match.')
  if (Date.parse(snapshot.createdAt) > Date.parse(grant.issuedAt)) throw new Error('Snapshot is newer than authority.')
}

export async function verifyOfflineBundle(snapshotEnvelope: unknown, authorityEnvelope: unknown, trustedKeys: Readonly<Record<string, CryptoKey>>) {
  const snapshot = await verifySignedEnvelope(snapshotEnvelope, offlineSnapshotSchema, trustedKeys)
  const authority = await verifySignedEnvelope(authorityEnvelope, offlineAuthoritySchema, trustedKeys)
  assertBundleScope(snapshot.payload, authority.payload, snapshot.payloadSha256)
  return { snapshot: snapshot.payload, authority: authority.payload, snapshotSha256: snapshot.payloadSha256, authoritySha256: authority.payloadSha256 }
}

export async function publicKeyFingerprint(key: CryptoKey): Promise<string> {
  assertP256(key, 'verify')
  return sha256Hex(new Uint8Array(await crypto.subtle.exportKey('spki', key)))
}

/** Bundle must come from verifyOfflineBundle; DB ownership/budget checks remain mandatory. */
export async function verifyOfflineIssuance(
  envelope: unknown,
  bundle: Awaited<ReturnType<typeof verifyOfflineBundle>>,
  enrolledPublicKey: CryptoKey,
): Promise<{ issuance: OfflineIssuance; payloadSha256: string }> {
  const fingerprint = await publicKeyFingerprint(enrolledPublicKey)
  if (fingerprint !== bundle.authority.deviceKeySha256) throw new Error('Device key differs from authority.')
  const verified = await verifySignedEnvelope(envelope, offlineIssuanceSchema, { [fingerprint]: enrolledPublicKey })
  return {
    issuance: validateIssuanceAgainstAuthority(verified.payload, bundle.authority, bundle.snapshot, bundle.authoritySha256),
    payloadSha256: verified.payloadSha256,
  }
}

/** Historical verification only; current menu/access/clock must not reprice issued bills.
 * Database transactions must additionally enforce unique number, chain and aggregate budgets. */
export function validateIssuanceAgainstAuthority(
  raw: unknown, grant: OfflineAuthority, snapshot: OfflineSnapshot, authoritySha256: string,
): OfflineIssuance {
  const issuance = offlineIssuanceSchema.parse(raw)
  const document = issuance.document
  assertBundleScope(snapshot, grant, issuance.snapshotSha256)
  if (issuance.authorityId !== grant.id || issuance.authoritySha256 !== authoritySha256 ||
    document.branchId !== grant.branchId || document.deviceId !== grant.deviceId ||
    document.actorId !== grant.actorId || document.shiftId !== grant.shiftId ||
    canonicalJson(document.merchant) !== canonicalJson(snapshot.profile)) throw new Error('Issuance authority scope differs.')
  const issuedAt = Date.parse(document.issuedAt)
  if (issuedAt < Date.parse(grant.notBefore) || issuedAt >= Date.parse(grant.expiresAt)) throw new Error('Invoice time is outside its authority.')
  const prefix = grant.invoiceRange.prefix + '-INV-'
  const sequence = Number(document.documentNumber.slice(prefix.length))
  if (!document.documentNumber.startsWith(prefix) || !Number.isSafeInteger(sequence) || sequence < grant.invoiceRange.first || sequence > grant.invoiceRange.last)
    throw new Error('Invoice number is not reserved by this authority.')
  if (document.totals.grossFils > grant.maxInvoiceTotalFils || document.totals.grossFils > grant.maxGrossFils)
    throw new Error('Invoice exceeds authority budget.')
  if (document.payments.some((payment) => payment.method === 'cash' ? !grant.permissions.cash : !grant.permissions.recordedCard) ||
    (document.payments.length > 1 && !grant.permissions.mixedTender)) throw new Error('Tender is outside authority.')
  const products = new Map(snapshot.products.map((product) => [product.id, product]))
  for (const line of document.lines) {
    const product = products.get(line.productId)
    if (!product || line.name !== product.name || line.unit !== product.unit || line.unitPriceFils !== product.unitPriceFils || line.taxRateBps !== product.taxRateBps)
      throw new Error('Invoice line differs from its historical catalogue.')
  }
  return issuance
}

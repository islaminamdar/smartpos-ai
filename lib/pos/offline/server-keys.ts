import { z } from 'zod'
import { PosServerError } from '../server/client'
import { decodeBase64Url, encodeBase64Url } from './canonical'
import { publicKeyFingerprint, signEnvelope, verifySignedEnvelope } from './authority'

const idSchema = z.string().regex(/^[A-Za-z0-9._-]{1,120}$/)
const keySchema = z.object({ id: idSchema, publicKeySpki: z.string().max(342), privateKeyPkcs8: z.string().max(2731).optional() }).strict()
export type OfflineServerKeys = { activeId: string; privateKey: CryptoKey; publicKeys: Record<string, CryptoKey> }

/** Private environment only. Preserve historical public keys when rotating the active signer. */
export async function offlineServerKeys(): Promise<OfflineServerKeys> {
  try {
    const raw = process.env.POS_OFFLINE_SERVER_KEYS
    if (!raw || raw.length > 32_768) throw new Error()
    const rows = z.array(keySchema).min(1).max(8).parse(JSON.parse(raw))
    const activeId = idSchema.parse(process.env.POS_OFFLINE_SIGNING_KEY_ID)
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error()
    const publicKeys: Record<string, CryptoKey> = Object.create(null)
    let privateKey: CryptoKey | undefined
    for (const row of rows) {
      publicKeys[row.id] = await importOfflinePublicKey(row.publicKeySpki)
      if (row.id === activeId && row.privateKeyPkcs8) privateKey = await crypto.subtle.importKey('pkcs8', decodeBase64Url(row.privateKeyPkcs8, 2048),
        { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    }
    if (!privateKey || !publicKeys[activeId]) throw new Error()
    // Fail configuration before reserving invoice numbers if the supplied key pair differs.
    const proof = await signEnvelope({ kind: 'offline-key-check' }, activeId, privateKey)
    await verifySignedEnvelope(proof, z.object({ kind: z.literal('offline-key-check') }).strict(), publicKeys)
    return { activeId, privateKey, publicKeys }
  } catch { throw new PosServerError('offline_signing_unavailable', 503) }
}

export async function importOfflinePublicKey(encoded: string): Promise<CryptoKey> {
  const bytes = decodeBase64Url(encoded, 256)
  const key = await crypto.subtle.importKey('spki', bytes, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
  if (encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', key))) !== encoded) throw new Error('Noncanonical public key.')
  await publicKeyFingerprint(key)
  return key
}

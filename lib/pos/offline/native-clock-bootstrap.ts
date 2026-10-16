import { z } from 'zod'
import { posClient, PosServerError } from '../server/client'
import { hashToken } from '../server/live-access'
import { loginSourceKey } from '../server/login-source'
import { offlineUuid } from './server-contracts'
import { signEnvelope, verifySignedEnvelope } from './authority'
import { offlineServerKeys } from './server-keys'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const context = {
  schemaVersion: z.literal(1),
  installationId: offlineUuid,
  deviceKeySha256: hash,
  oldClockGeneration: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER - 1),
  oldClockSha256: hash,
  challenge: hash,
}
export const nativeClockBootstrapRequestSchema = z.object(context).strict()
export const nativeClockBootstrapTimeSchema = z
  .object({
    ...context,
    kind: z.literal('native-clock-bootstrap-time'),
    serverTimeMs: z.number().int().min(0).max(253_402_300_799_999),
  })
  .strict()

/** Public time signing has its own source and global work budget. These rate rows
 * are the only database writes; this endpoint never grants device authority. */
export async function limitNativeClockBootstrap(request: Request) {
  const source = loginSourceKey(request)
  for (const key of [
    hashToken('native-clock-bootstrap-global-v1'),
    hashToken(`native-clock-bootstrap-source-v1:${source}`),
  ]) {
    const { data, error } = await posClient(undefined, true).rpc('pos_offline_limit', {
      p_source: key,
    })
    if (error || typeof data !== 'boolean')
      throw new PosServerError('clock_bootstrap_unavailable', 503)
    if (!data) throw new PosServerError('clock_bootstrap_rate_limited', 429)
  }
}

/** Caller identity is deliberately NOT authenticated. The signed domain only
 * conveys server time; native code must independently prove pristine custody. */
export async function nativeClockBootstrap(raw: unknown) {
  const request = nativeClockBootstrapRequestSchema.parse(raw)
  const keys = await offlineServerKeys()
  const payload = nativeClockBootstrapTimeSchema.parse({
    ...request,
    kind: 'native-clock-bootstrap-time',
    serverTimeMs: Date.now(),
  })
  const time = await signEnvelope(payload, keys.activeId, keys.privateKey)
  await verifySignedEnvelope(time, nativeClockBootstrapTimeSchema, keys.publicKeys)
  return { status: 'ready' as const, time }
}

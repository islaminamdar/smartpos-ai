import { z } from 'zod'
import { posClient, PosServerError } from '../server/client'
import { offlineExceptionSchema } from './server-contracts'
import type { SignedEnvelope } from './contracts'

/** Historical schemas intentionally retain this character. PostgreSQL jsonb cannot store it. */
export function hasUnsupportedCustomerText(customer: { name: string; address: string } | null): boolean {
  return customer !== null && (customer.name.includes('\u0000') || customer.address.includes('\u0000'))
}

const retainedSchema = offlineExceptionSchema.extend({ code: z.literal('unsupported_text') })

/** Internal custody boundary: callers must verify the device signature, historical authority,
 * full payload schema and arithmetic first. This retains the original ASCII envelope, never
 * an altered invoice or a fiscal acknowledgement. SQL019 applies the corresponding hold. */
export async function retainVerifiedUnsupportedEvidence(authorityId: string, envelope: SignedEnvelope) {
  const { data, error } = await posClient(undefined, true).rpc('pos_offline_retain_unsupported', {
    p_authority: authorityId, p_envelope: envelope,
  })
  const parsed = retainedSchema.safeParse(data)
  if (error || !parsed.success) throw new PosServerError('offline_storage_unavailable', 503)
  return parsed.data
}

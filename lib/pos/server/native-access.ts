import { z } from 'zod'
import { authenticatedPosClient, PosServerError } from './client'
import { boundDevice, requirePilot } from './live-access'

const uuid = z.string().uuid()
export const nativeDeviceSchema = z.object({ id: uuid, branchId: uuid, name: z.string().min(1).max(80) }).strict()
export const nativeAccessSchema = z.object({
  schemaVersion: z.literal(1), status: z.literal('signed_in'), actorId: uuid,
  branches: z.array(z.object({ id: uuid, organizationId: uuid, name: z.string().min(1).max(200), role: z.enum(['owner','manager','cashier']) }).strict()).min(1).max(500),
  device: nativeDeviceSchema.nullable(), canPrepareOffline: z.literal(false),
}).strict()

/** Minimal native session context; deliberately does not deliver tokens, menu, or authority. */
export async function nativeAccess() {
  requirePilot()
  const { client, user } = await authenticatedPosClient()
  const [branches, staff] = await Promise.all([
    client.from('pos_branches').select('id,organization_id,name').eq('active', true).limit(501),
    client.from('pos_staff').select('organization_id,branch_id,role').eq('user_id', user.id).eq('active', true).limit(501),
  ])
  if (branches.error || staff.error || !Array.isArray(branches.data) || !Array.isArray(staff.data) || branches.data.length > 500 || staff.data.length > 500)
    throw new PosServerError('native_access_unavailable', 503)
  const allowed = branches.data.flatMap(branch => {
    const member = staff.data.find(s => s.organization_id === branch.organization_id && (!s.branch_id || s.branch_id === branch.id))
    return member ? [{ id: branch.id, organizationId: branch.organization_id, name: branch.name, role: member.role }] : []
  })
  if (!allowed.length) throw new PosServerError('access_denied', 403)
  const binding = await boundDevice(client, user.id)
  if (binding && !allowed.some(branch => branch.id === binding.device.branchId)) throw new PosServerError('access_denied', 403)
  return nativeAccessSchema.parse({ schemaVersion: 1, status: 'signed_in', actorId: user.id, branches: allowed, device: binding?.device ?? null, canPrepareOffline: false })
}

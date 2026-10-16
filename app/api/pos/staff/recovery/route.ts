import { NextResponse } from 'next/server'
import { z } from 'zod'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import {
  requirePilot,
  requireOrigin,
  recoveryBinding,
  hashToken,
} from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import {
  staffUpdateSchema,
  staffInviteCommandSchema,
  staffRevokeCommandSchema,
  staffUpdateResultSchema,
  staffInviteResultSchema,
  staffRevokeResultSchema,
} from '@/lib/pos/server/staff'
import {
  staffBody,
  staffRpcError,
  invitationToken,
  invitationUrl,
} from '@/lib/pos/server/staff-access'
const recovery = z.discriminatedUnion('endpoint', [
  z.object({ endpoint: z.literal('/api/pos/staff'), request: staffUpdateSchema }).strict(),
  z
    .object({
      endpoint: z.literal('/api/pos/staff/invitations'),
      request: staffInviteCommandSchema,
    })
    .strict(),
  z
    .object({
      endpoint: z.literal('/api/pos/staff/invitations/revoke'),
      request: staffRevokeCommandSchema,
    })
    .strict(),
])
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requirePilot()
    requireOrigin(request)
    const { client, user } = await authenticatedPosClient()
    const parsed = recovery.safeParse(await staffBody(request))
    if (!parsed.success) throw new PosServerError('invalid_staff_request', 422)
    const input = parsed.data,
      command = input.request
    const kind =
      input.endpoint === '/api/pos/staff'
        ? 'staff.update'
        : input.endpoint.endsWith('/revoke')
          ? 'invitation.revoke'
          : 'invitation.create'
    const binding = await recoveryBinding(user.id)
    const token =
      kind === 'invitation.create' ? invitationToken(user.id, command.branchId, command.id) : null
    const setupUrl = token ? invitationUrl(token) : null
    const { data, error } = await client.rpc('pos_resolve_staff_request', {
      p_kind: kind,
      p_command: command,
      p_binding: binding,
      p_token_hash: token ? hashToken(token) : null,
    })
    if (error) staffRpcError(error.message)
    if (data?.status === 'cancelled') {
      const result = z
        .object({
          status: z.literal('cancelled'),
          requestId: z.literal(command.id),
          kind: z.literal(kind),
          replayed: z.boolean(),
        })
        .strict()
        .parse(data)
      return NextResponse.json(result, { headers: privateHeaders })
    }
    if (input.endpoint === '/api/pos/staff') {
      const result = staffUpdateResultSchema.parse(data),
        c = input.request
      if (
        result.requestId !== c.id ||
        result.staff.userId !== c.targetUserId ||
        result.staff.revision !== c.expectedRevision + 1 ||
        result.staff.active !== c.active ||
        result.staff.role !== c.role ||
        result.staff.branchId !== c.assignedBranchId ||
        result.staff.displayName !== c.displayName
      )
        throw new PosServerError('confirmation_mismatch', 503)
      return NextResponse.json(result, { headers: privateHeaders })
    }
    if (input.endpoint === '/api/pos/staff/invitations') {
      const result = staffInviteResultSchema.parse({ ...data, setupUrl }),
        c = input.request
      if (
        result.requestId !== c.id ||
        result.invitation.id !== c.id ||
        result.invitation.email !== c.email ||
        result.invitation.displayName !== c.displayName ||
        result.invitation.role !== c.role ||
        result.invitation.branchId !== c.assignedBranchId ||
        new Date(result.invitation.expiresAt).getTime() !== new Date(c.expiresAt).getTime()
      )
        throw new PosServerError('confirmation_mismatch', 503)
      return NextResponse.json(result, { headers: privateHeaders })
    }
    const result = staffRevokeResultSchema.parse(data)
    if (result.requestId !== command.id || result.invitationId !== input.request.invitationId)
      throw new PosServerError('confirmation_mismatch', 503)
    return NextResponse.json(result, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}

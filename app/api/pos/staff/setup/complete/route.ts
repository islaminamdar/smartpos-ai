import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { posClient, saveSession, PosServerError } from '@/lib/pos/server/client'
import { requirePilot, requireOrigin, hashToken } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { staffBody, staffRpcError } from '@/lib/pos/server/staff-access'
import { staffAcceptResultSchema } from '@/lib/pos/server/staff'
import {
  staffSetupCompleteSchema,
  staffSetupContextSchema,
  prepareStaffSetup,
  setupRpcError,
} from '@/lib/pos/server/staff-setup'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requirePilot()
    requireOrigin(request)
    const parsed = staffSetupCompleteSchema.safeParse(await staffBody(request))
    if (!parsed.success) throw new PosServerError('invalid_setup_request', 422)
    const input = parsed.data
    const admin = await prepareStaffSetup(request, input.email)
    const lookup = await admin.rpc('pos_staff_setup_consume', {
      p_token_hash: hashToken(input.token),
      p_email: input.email,
      p_attempt: input.attemptId,
      p_code_hash: hashToken(input.token + ':' + input.code),
    })
    if (lookup.error) setupRpcError(lookup.error.message)
    const context = staffSetupContextSchema.parse(lookup.data)
    if (
      context.existingConfirmed ||
      context.email !== input.email ||
      context.attemptId !== input.attemptId ||
      !context.setupUserId ||
      !context.setupExpiresAt ||
      Date.parse(context.setupExpiresAt) <= Date.now() ||
      !context.codeHash ||
      !timingSafeEqual(
        Buffer.from(context.codeHash, 'hex'),
        Buffer.from(hashToken(input.token + ':' + input.code), 'hex')
      )
    )
      throw new PosServerError('verification_code_invalid', 401)
    const client = posClient()
    const verified = await client.auth.verifyOtp({
      email: input.email,
      token: input.code,
      type: 'invite',
    })
    if (verified.error || !verified.data.user || !verified.data.session)
      throw new PosServerError('verification_code_invalid', 401)
    const { user, session } = verified.data
    let retained = false,
      passwordChanged = false
    try {
      if (
        user.id !== context.setupUserId ||
        user.email?.toLowerCase() !== input.email ||
        !user.email_confirmed_at
      )
        throw new PosServerError('invitation_identity_required', 403)
      // This exact client holds the one-time recipient verification session, never an admin session.
      const updated = await client.auth.updateUser({ password: input.password })
      if (updated.error || updated.data.user?.id !== user.id)
        throw new PosServerError('account_setup_unconfirmed', 503)
      passwordChanged = true
      const joined = await posClient(session.access_token).rpc('pos_accept_staff_invitation', {
        p_token_hash: hashToken(input.token),
      })
      if (joined.error) staffRpcError(joined.error.message)
      const result = staffAcceptResultSchema.parse(joined.data)
      if (result.invitationId !== context.invitationId)
        throw new PosServerError('confirmation_mismatch', 503)
      await saveSession(session)
      retained = true
      return NextResponse.json(result, { headers: privateHeaders })
    } catch (error) {
      if (passwordChanged) throw new PosServerError('account_created_access_unconfirmed', 503)
      throw error
    } finally {
      if (!retained)
        await admin.auth.admin.signOut(session.access_token, 'local').catch(() => undefined)
    }
  } catch (error) {
    return posFailure(error)
  }
}

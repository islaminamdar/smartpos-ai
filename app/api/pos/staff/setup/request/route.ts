import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { PosServerError } from '@/lib/pos/server/client'
import { requirePilot, requireOrigin, hashToken } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { staffBody } from '@/lib/pos/server/staff-access'
import {
  staffSetupRequestSchema,
  staffSetupContextSchema,
  prepareStaffSetup,
  setupRpcError,
} from '@/lib/pos/server/staff-setup'
import { sendStaffSetupCode } from '@/lib/pos/server/staff-mail'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requirePilot()
    requireOrigin(request)
    const input = staffSetupRequestSchema.safeParse(await staffBody(request))
    if (!input.success) throw new PosServerError('invalid_setup_request', 422)
    const { token, email } = input.data
    const admin = await prepareStaffSetup(request, email)
    const attemptId = randomUUID()
    const claim = await admin.rpc('pos_staff_setup_claim', {
      p_token_hash: hashToken(token),
      p_email: email,
      p_attempt: attemptId,
    })
    if (claim.error) setupRpcError(claim.error.message)
    const context = staffSetupContextSchema.parse(claim.data)
    if (context.email !== email) throw new PosServerError('confirmation_mismatch', 503)
    // A setup request never changes an existing confirmed user's password or emails a recovery token.
    const accepted = () =>
      NextResponse.json({ status: 'setup_requested', attemptId }, { headers: privateHeaders })
    if (context.existingConfirmed) return accepted()
    const generated = await admin.auth.admin.generateLink({ type: 'invite', email })
    if (generated.error) {
      if (generated.error.code === 'email_exists' || generated.error.code === 'user_already_exists')
        return accepted()
      throw new PosServerError('verification_request_unconfirmed', 503)
    }
    const { user, properties } = generated.data
    if (
      !user ||
      user.email?.toLowerCase() !== email ||
      user.email_confirmed_at ||
      properties?.verification_type !== 'invite' ||
      !/^\d{6,10}$/.test(properties.email_otp)
    )
      throw new PosServerError('verification_request_unconfirmed', 503)
    const bound = await admin.rpc('pos_staff_setup_bind', {
      p_token_hash: hashToken(token),
      p_email: email,
      p_attempt: attemptId,
      p_user: user.id,
      p_code_hash: hashToken(token + ':' + properties.email_otp),
    })
    if (bound.error) setupRpcError(bound.error.message)
    if (bound.data !== true) throw new PosServerError('verification_request_unconfirmed', 503)
    await sendStaffSetupCode(email, properties.email_otp)
    return accepted()
  } catch (error) {
    return posFailure(error)
  }
}

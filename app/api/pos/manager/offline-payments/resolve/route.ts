import { NextResponse } from 'next/server'
import { z } from 'zod'
import { PosServerError } from '@/lib/pos/server/client'
import { privateHeaders } from '@/lib/pos/server/http'
import { readBoundedBody } from '@/lib/pos/server/body'
import { requireOrigin } from '@/lib/pos/server/live-access'
import { offlineFailure } from '@/lib/pos/offline/http'
import { offlineUuid } from '@/lib/pos/offline/server-contracts'
import { paymentDecisionRequestSchema } from '@/lib/pos/offline/payment-review-contracts'
import { paymentReviewActor, decidePaymentReview } from '@/lib/pos/offline/payment-review'
export const dynamic = 'force-dynamic'
// Candidate route: deliberately absent from the hosted release allowlist until native
// result acceptance and full operational acceptance exist. No browser-driven enable switch.
export async function POST(request: Request) {
  try {
    requireOrigin(request)
    const user = await paymentReviewActor(request)
    const parsed = z.object({ branchId: offlineUuid, request: paymentDecisionRequestSchema,
      currentPassword: z.string().min(1).max(256) }).strict()
      .safeParse(JSON.parse(await readBoundedBody(request, 16_384)))
    if (!parsed.success) throw new PosServerError('invalid_payment_decision', 422)
    const { branchId, request: decision, currentPassword } = parsed.data
    return NextResponse.json(await decidePaymentReview(request, user, branchId, decision, currentPassword), { headers: privateHeaders })
  } catch (error) { return offlineFailure(error) }
}

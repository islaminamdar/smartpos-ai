import { NextResponse } from 'next/server'
import { z } from 'zod'
import { PosServerError } from '@/lib/pos/server/client'
import { privateHeaders } from '@/lib/pos/server/http'
import { offlineFailure } from '@/lib/pos/offline/http'
import { offlineUuid } from '@/lib/pos/offline/server-contracts'
import { listPaymentReviews, paymentReviewActor } from '@/lib/pos/offline/payment-review'
export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  try {
    const user = await paymentReviewActor(request)
    const query = z.object({ branchId: offlineUuid, cursor: z.string().max(400).optional() }).strict()
      .safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!query.success) throw new PosServerError('invalid_query', 422)
    return NextResponse.json(await listPaymentReviews(user.id, query.data.branchId, query.data.cursor ?? null), { headers: privateHeaders })
  } catch (error) { return offlineFailure(error) }
}

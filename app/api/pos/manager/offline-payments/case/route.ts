import { NextResponse } from 'next/server'
import { z } from 'zod'
import { PosServerError } from '@/lib/pos/server/client'
import { privateHeaders } from '@/lib/pos/server/http'
import { offlineFailure } from '@/lib/pos/offline/http'
import { offlineUuid } from '@/lib/pos/offline/server-contracts'
import { paymentReviewActor, readPaymentReview } from '@/lib/pos/offline/payment-review'
export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  try {
    const user = await paymentReviewActor(request)
    const query = z.object({ branchId: offlineUuid, caseId: offlineUuid, caseKind: z.enum(['freeze', 'raw']) }).strict()
      .safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!query.success) throw new PosServerError('invalid_query', 422)
    const result = await readPaymentReview(user.id, query.data.branchId, query.data.caseId, query.data.caseKind)
    return NextResponse.json(result, { headers: privateHeaders })
  } catch (error) { return offlineFailure(error) }
}

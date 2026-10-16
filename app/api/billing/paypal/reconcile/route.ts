import { NextResponse } from 'next/server'
import { branchSchema } from '@/lib/billing/paypal/contracts'
import { reconcileBranch } from '@/lib/billing/paypal/service'
import { billingFailure } from '@/lib/billing/paypal/http'
import { readBoundedBody } from '@/lib/pos/server/body'
import { requireOrigin } from '@/lib/pos/server/live-access'
import { privateHeaders } from '@/lib/pos/server/http'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requireOrigin(request)
    const body = branchSchema.parse(JSON.parse(await readBoundedBody(request, 2048)))
    return NextResponse.json(await reconcileBranch(body.branchId), { headers: privateHeaders })
  } catch (error) {
    return billingFailure(error)
  }
}

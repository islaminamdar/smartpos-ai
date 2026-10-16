import { NextResponse } from 'next/server'
import { receiveWebhook } from '@/lib/billing/paypal/service'
import { billingFailure } from '@/lib/billing/paypal/http'
import { readBoundedBody } from '@/lib/pos/server/body'
import { privateHeaders } from '@/lib/pos/server/http'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    return NextResponse.json(
      await receiveWebhook(await readBoundedBody(request, 150000), request.headers),
      { headers: privateHeaders }
    )
  } catch (error) {
    return billingFailure(error)
  }
}

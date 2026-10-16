import { NextResponse } from 'next/server'
import { branchSchema } from '@/lib/billing/paypal/contracts'
import { billingStatus } from '@/lib/billing/paypal/service'
import { billingFailure } from '@/lib/billing/paypal/http'
import { privateHeaders } from '@/lib/pos/server/http'
export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  try {
    const { branchId } = branchSchema.parse(Object.fromEntries(new URL(request.url).searchParams))
    return NextResponse.json(await billingStatus(branchId), { headers: privateHeaders })
  } catch (error) {
    return billingFailure(error)
  }
}

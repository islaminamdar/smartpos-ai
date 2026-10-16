import { NextResponse } from 'next/server'
import { registerAndRecoverOfflinePayment } from '@/lib/pos/offline/payment-retrieval'
import { limitOfflineRecovery } from '@/lib/pos/offline/server'
import { offlineFailure } from '@/lib/pos/offline/http'
import { readBoundedBody } from '@/lib/pos/server/body'
import { privateHeaders } from '@/lib/pos/server/http'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    await limitOfflineRecovery(request)
    return NextResponse.json(await registerAndRecoverOfflinePayment(JSON.parse(await readBoundedBody(request, 1_420_000))), { headers: privateHeaders })
  } catch (error) { return offlineFailure(error) }
}

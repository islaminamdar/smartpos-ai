import { NextResponse } from 'next/server'
import { readBoundedBody } from '@/lib/pos/server/body'
import { requireOrigin } from '@/lib/pos/server/live-access'
import { privateHeaders } from '@/lib/pos/server/http'
import { enrollOfflineDevice, OfflineEnrollmentProofExpired } from '@/lib/pos/offline/server'
import { offlineFailure } from '@/lib/pos/offline/http'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requireOrigin(request)
    return NextResponse.json(await enrollOfflineDevice(JSON.parse(await readBoundedBody(request, 16_384))), { headers: privateHeaders })
  } catch (error) {
    if (error instanceof OfflineEnrollmentProofExpired) return NextResponse.json({ status: 'not_enrolled',
      code: error.code, requestId: error.requestId, requestSha256: error.requestSha256 }, { status: 409, headers: privateHeaders })
    return offlineFailure(error)
  }
}

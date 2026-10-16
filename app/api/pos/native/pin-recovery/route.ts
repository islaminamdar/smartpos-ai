import { NextResponse } from 'next/server'
import { nativePinRecovery, PinRecoveryProofExpired } from '@/lib/pos/offline/native-pin-recovery'
import { limitOfflineRecovery } from '@/lib/pos/offline/server'
import { requireOrigin } from '@/lib/pos/server/live-access'
import { readBoundedBody } from '@/lib/pos/server/body'
import { privateHeaders } from '@/lib/pos/server/http'
import { offlineFailure } from '@/lib/pos/offline/http'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requireOrigin(request)
    await limitOfflineRecovery(request)
    return NextResponse.json(
      await nativePinRecovery(request, JSON.parse(await readBoundedBody(request, 16_384))),
      { headers: privateHeaders }
    )
  } catch (error) {
    if (error instanceof PinRecoveryProofExpired)
      return NextResponse.json(
        {
          status: 'not_approved',
          code: error.code,
          requestId: error.requestId,
          proofSha256: error.proofSha256,
        },
        { status: 409, headers: privateHeaders }
      )
    return offlineFailure(error)
  }
}

import { NextResponse } from 'next/server'
import { nativeShiftClose } from '@/lib/pos/offline/native-shift-close'
import { limitOfflineRecovery } from '@/lib/pos/offline/server'
import { requireOrigin } from '@/lib/pos/server/live-access'
import { readBoundedBody } from '@/lib/pos/server/body'
import { privateHeaders } from '@/lib/pos/server/http'
import { offlineFailure } from '@/lib/pos/offline/http'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requireOrigin(request); await limitOfflineRecovery(request)
    return NextResponse.json(await nativeShiftClose(JSON.parse(await readBoundedBody(request, 1024))), { headers: privateHeaders })
  } catch (error) { return offlineFailure(error) }
}

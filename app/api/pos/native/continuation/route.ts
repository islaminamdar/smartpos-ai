import { NextResponse } from 'next/server'
import { nativeOfflineContinuation } from '@/lib/pos/offline/native-continuation'
import { requireNativePreparationEnabled } from '@/lib/pos/offline/native-preparation'
import { limitOfflineRecovery } from '@/lib/pos/offline/server'
import { requireOrigin } from '@/lib/pos/server/live-access'
import { readBoundedBody } from '@/lib/pos/server/body'
import { privateHeaders } from '@/lib/pos/server/http'
import { offlineFailure } from '@/lib/pos/offline/http'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requireOrigin(request); requireNativePreparationEnabled(); await limitOfflineRecovery(request)
    return NextResponse.json(await nativeOfflineContinuation(JSON.parse(await readBoundedBody(request, 1024))), { headers: privateHeaders })
  } catch (error) { return offlineFailure(error) }
}

import { NextResponse } from 'next/server'
import { nativeOfflineContext, requireNativePreparationEnabled } from '@/lib/pos/offline/native-preparation'
import { offlineFailure } from '@/lib/pos/offline/http'
import { readBoundedBody } from '@/lib/pos/server/body'
import { requireOrigin } from '@/lib/pos/server/live-access'
import { privateHeaders } from '@/lib/pos/server/http'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requireOrigin(request); requireNativePreparationEnabled()
    return NextResponse.json(await nativeOfflineContext(JSON.parse(await readBoundedBody(request, 1024))), { headers: privateHeaders })
  } catch (error) { return offlineFailure(error) }
}

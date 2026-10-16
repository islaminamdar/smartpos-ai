import { NextResponse } from 'next/server'
import { readBoundedBody } from '@/lib/pos/server/body'
import { requireOrigin } from '@/lib/pos/server/live-access'
import { privateHeaders } from '@/lib/pos/server/http'
import { enrollOfflineDevice } from '@/lib/pos/offline/server'
import { offlineFailure } from '@/lib/pos/offline/http'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requireOrigin(request)
    return NextResponse.json(await enrollOfflineDevice(JSON.parse(await readBoundedBody(request, 16_384))), { headers: privateHeaders })
  } catch (error) { return offlineFailure(error) }
}

import { NextResponse } from 'next/server'
import { readBoundedBody } from '@/lib/pos/server/body'
import { privateHeaders } from '@/lib/pos/server/http'
import { sealOfflineAuthority, limitOfflineRecovery } from '@/lib/pos/offline/server'
import { offlineFailure } from '@/lib/pos/offline/http'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    await limitOfflineRecovery(request)
    return NextResponse.json(await sealOfflineAuthority(JSON.parse(await readBoundedBody(request, 16_384))), { headers: privateHeaders })
  } catch (error) { return offlineFailure(error) }
}

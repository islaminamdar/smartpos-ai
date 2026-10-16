import { NextResponse } from 'next/server'
import { recoverOfflineBundle } from '@/lib/pos/offline/bundle-recovery'
import { limitOfflineRecovery } from '@/lib/pos/offline/server'
import { offlineFailure } from '@/lib/pos/offline/http'
import { readBoundedBody } from '@/lib/pos/server/body'
import { privateHeaders } from '@/lib/pos/server/http'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    await limitOfflineRecovery(request)
    return NextResponse.json(await recoverOfflineBundle(JSON.parse(await readBoundedBody(request, 16_384))), { headers: privateHeaders })
  } catch (error) { return offlineFailure(error) }
}

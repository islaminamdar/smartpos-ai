import { NextResponse } from 'next/server'
import { readBoundedBody } from '@/lib/pos/server/body'
import { requireOrigin } from '@/lib/pos/server/live-access'
import { privateHeaders } from '@/lib/pos/server/http'
import { reserveOfflineAuthority } from '@/lib/pos/offline/server'
import { offlineFailure } from '@/lib/pos/offline/http'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requireOrigin(request)
    return NextResponse.json(await reserveOfflineAuthority(JSON.parse(await readBoundedBody(request, 4096))), { headers: privateHeaders })
  } catch (error) { return offlineFailure(error) }
}

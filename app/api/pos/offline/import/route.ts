import { NextResponse } from 'next/server'
import { readBoundedBody } from '@/lib/pos/server/body'
import { privateHeaders } from '@/lib/pos/server/http'
import { importOfflineReceipt, limitOfflineRecovery } from '@/lib/pos/offline/server'
import { offlineFailure } from '@/lib/pos/offline/http'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    // This path authenticates the signed device evidence, never browser cookies or Origin.
    await limitOfflineRecovery(request)
    const result = await importOfflineReceipt(JSON.parse(await readBoundedBody(request, 1_400_000)))
    return NextResponse.json(result, { status: result.status === 'reconciliation_required' ? 409 : 200, headers: privateHeaders })
  } catch (error) { return offlineFailure(error) }
}

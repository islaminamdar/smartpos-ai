import { NextResponse } from 'next/server'
import {
  limitNativeClockBootstrap,
  nativeClockBootstrap,
} from '@/lib/pos/offline/native-clock-bootstrap'
import { requireOrigin } from '@/lib/pos/server/live-access'
import { readBoundedBytes } from '@/lib/pos/server/body'
import { privateHeaders } from '@/lib/pos/server/http'
import { offlineFailure } from '@/lib/pos/offline/http'
import { parseCanonicalPayload } from '@/lib/pos/offline/canonical'
import { PosServerError } from '@/lib/pos/server/client'

export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requireOrigin(request)
    await limitNativeClockBootstrap(request)
    const bytes = await readBoundedBytes(request, 2_048, 10_000)
    let body: unknown
    try {
      body = parseCanonicalPayload(bytes)
    } catch {
      throw new PosServerError('invalid_offline_request', 422)
    }
    return NextResponse.json(await nativeClockBootstrap(body), { headers: privateHeaders })
  } catch (error) {
    return offlineFailure(error)
  }
}

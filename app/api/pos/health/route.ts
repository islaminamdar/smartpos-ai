import { NextResponse } from 'next/server'
import { posClient } from '@/lib/pos/server/client'

export const dynamic = 'force-dynamic'
export async function GET() {
  const live = process.env.POS_ONLINE_PILOT === 'true' && process.env.POS_LIVE_SALES_ENABLED === 'true'
  let ready = false
  try {
    const { error } = await posClient(undefined, true)
      .from('pos_organizations')
      .select('id')
      .limit(1)
      .abortSignal(AbortSignal.timeout(2500))
    ready = !error
  } catch {
    ready = false
  }
  return NextResponse.json(
    {
      status: ready ? 'ok' : 'degraded',
      selling: live && ready ? 'online_pilot' : 'unavailable',
      liveSalesEnabled: live && ready,
      offlineSalesEnabled: false,
      release: process.env.POS_RELEASE_ID || 'local',
    },
    { status: ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } }
  )
}

import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export function GET() {
  return NextResponse.json(
    {
      status: 'ok',
      selling: process.env.POS_ONLINE_PILOT === 'true' && process.env.POS_LIVE_SALES_ENABLED === 'true' ? 'online_pilot' : 'training_only',
      liveSalesEnabled: process.env.POS_ONLINE_PILOT === 'true' && process.env.POS_LIVE_SALES_ENABLED === 'true',
      offlineSalesEnabled: false,
      release: process.env.POS_RELEASE_ID || 'local',
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}

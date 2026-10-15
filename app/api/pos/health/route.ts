import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export function GET() {
  return NextResponse.json(
    {
      status: 'ok',
      selling: 'training_only',
      liveSalesEnabled: false,
      release: process.env.POS_RELEASE_ID || 'local',
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}

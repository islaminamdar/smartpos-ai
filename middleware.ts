import { NextResponse, type NextRequest } from 'next/server'
import { publicReleaseAccess } from '@/lib/pos/public-release'

export function middleware(req: NextRequest) {
  // Legacy APIs, pages and Server Actions stay denied in both release modes.
  const access = publicReleaseAccess(req.nextUrl.pathname, req.method, process.env.POS_ONLINE_PILOT === 'true')
  if (access === 'not_found') return new NextResponse('Not found', { status: 404 })
  if (access === 'unavailable') return NextResponse.json(
    { status: 'setup_required', code: 'live_sales_not_enabled' },
    { status: 503, headers: { 'Cache-Control': 'private, no-store' } }
  )
  return NextResponse.next()
}
export const config = { matcher: ['/:path*'] }

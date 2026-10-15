import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { publicReleaseAccess } from '@/lib/pos/public-release'

export async function middleware(req: NextRequest) {
  if (process.env.POS_PUBLIC_RELEASE_ONLY === 'true') {
    const access = publicReleaseAccess(req.nextUrl.pathname, req.method)
    if (access === 'not_found') return new NextResponse('Not found', { status: 404 })
    if (access === 'unavailable')
      return NextResponse.json(
        { status: 'setup_required', code: 'live_sales_not_enabled' },
        { status: 503, headers: { 'Cache-Control': 'private, no-store' } }
      )
    return NextResponse.next()
  }
  const isAppRoute =
    req.nextUrl.pathname.startsWith('/dashboard') ||
    req.nextUrl.pathname.startsWith('/order') ||
    req.nextUrl.pathname.startsWith('/kds') ||
    req.nextUrl.pathname.startsWith('/onboarding')
  if (!isAppRoute) return NextResponse.next()
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return new NextResponse('Application setup required', { status: 503 })
  }
  const res = NextResponse.next()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (c) =>
          c.forEach(({ name, value, options }) => res.cookies.set(name, value, options)),
      },
    }
  )
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (isAppRoute && !user) {
    return NextResponse.redirect(new URL('/login', req.url))
  }
  return res
}

export const config = {
  matcher: ['/:path*'],
}

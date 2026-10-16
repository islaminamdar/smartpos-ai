import { NextResponse } from 'next/server'
import { nativeAccess } from '@/lib/pos/server/native-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
export const dynamic = 'force-dynamic'
export async function GET() {
  try { return NextResponse.json(await nativeAccess(), { headers: privateHeaders }) }
  catch (error) { return posFailure(error) }
}

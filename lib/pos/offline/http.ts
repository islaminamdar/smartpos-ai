import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { posFailure, privateHeaders } from '../server/http'
export function offlineFailure(error: unknown) {
  if (error instanceof ZodError) return NextResponse.json({ code: 'invalid_offline_request' }, { status: 422, headers: privateHeaders })
  return posFailure(error)
}

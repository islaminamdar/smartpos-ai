import { NextResponse } from 'next/server'
import { PosServerError } from './client'
import { PosPayloadTooLarge } from './body'

export const privateHeaders = { 'Cache-Control': 'private, no-store' }
export function posFailure(error: unknown) {
  if (error instanceof PosPayloadTooLarge) return NextResponse.json({ code: 'payload_too_large' }, { status: 413, headers: privateHeaders })
  if (error instanceof PosServerError) {
    return NextResponse.json({ status: 'unavailable', code: error.code }, { status: error.status, headers: privateHeaders })
  }
  return NextResponse.json({ status: 'unavailable', code: 'storage_unavailable' }, { status: 503, headers: privateHeaders })
}

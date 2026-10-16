import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { PayPalError } from './config'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
export function billingFailure(error: unknown) {
  if (error instanceof PayPalError)
    return NextResponse.json(
      { status: 'unavailable', code: error.code },
      { status: error.status, headers: privateHeaders }
    )
  if (error instanceof ZodError)
    return NextResponse.json(
      { code: 'invalid_billing_request' },
      { status: 422, headers: privateHeaders }
    )
  return posFailure(error)
}

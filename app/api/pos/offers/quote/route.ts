import { NextResponse } from 'next/server'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { requireOrigin, requirePilot } from '@/lib/pos/server/live-access'
import { readBoundedBody } from '@/lib/pos/server/body'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { offerQuoteRequestSchema, offerQuoteResponseSchema } from '@/lib/pos/server/offers'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    requirePilot()
    requireOrigin(request)
    const { client } = await authenticatedPosClient()
    const body = await readBoundedBody(request, 100_000)
    let raw: unknown
    try {
      raw = JSON.parse(body)
    } catch {
      throw new PosServerError('invalid_json', 400)
    }
    const parsed = offerQuoteRequestSchema.safeParse(raw)
    if (!parsed.success) throw new PosServerError('invalid_offer_quote', 422)
    const { data, error } = await client.rpc('pos_quote_offers', {
      p_branch: parsed.data.branchId,
      p_lines: parsed.data.lines,
      p_service_type: parsed.data.serviceType,
      p_coupon: parsed.data.couponCode,
    })
    if (error) {
      const map: Record<string, [string, number]> = {
        POS_ACCESS_DENIED: ['branch_access_required', 403],
        POS_PRICE_CHANGED: ['menu_changed', 409],
        POS_PRODUCT_UNAVAILABLE: ['menu_changed', 409],
        POS_INVALID_ORDER: ['invalid_offer_quote', 422],
        POS_INVALID_OFFER: ['invalid_offer_quote', 422],
      }
      const match = Object.entries(map).find(([code]) => error.message.includes(code))?.[1]
      throw new PosServerError(match?.[0] ?? 'storage_unavailable', match?.[1] ?? 503)
    }
    const result = offerQuoteResponseSchema.parse(data)
    if (result.branchId !== parsed.data.branchId)
      throw new PosServerError('confirmation_mismatch', 503)
    const items = new Map(parsed.data.lines.map((line) => [line.productId, line]))
    if (
      result.quotes.some(
        (quote) =>
          quote.lines.length !== items.size ||
          quote.lines.some((line) => {
            const input = items.get(line.productId)
            return (
              !input ||
              line.eligibleQuantityMilli > input.quantityMilli ||
              line.beforeDiscountFils !==
                Math.round((input.quantityMilli * input.expectedUnitPriceFils) / 1000) ||
              line.taxFils !==
                Math.round(
                  (line.grossFils * input.expectedTaxRateBps) / (10000 + input.expectedTaxRateBps)
                )
            )
          })
      )
    )
      throw new PosServerError('confirmation_mismatch', 503)
    return NextResponse.json(result, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}

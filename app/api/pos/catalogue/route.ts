import { NextResponse } from 'next/server'
import { z } from 'zod'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { requireOrigin, requirePilot, requireDevice } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { readBoundedBody } from '@/lib/pos/server/body'
import {
  catalogueProductSchema,
  catalogueUpdateSchema,
  catalogueResultSchema,
} from '@/lib/pos/server/catalogue'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    requirePilot()
    const { client, user } = await authenticatedPosClient()
    const query = z
      .object({ branchId: z.string().uuid() })
      .strict()
      .safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!query.success) throw new PosServerError('invalid_query', 422)
    const branch = await client
      .from('pos_branches')
      .select('organization_id')
      .eq('id', query.data.branchId)
      .eq('active', true)
      .maybeSingle()
    if (branch.error) throw new PosServerError('storage_unavailable', 503)
    if (!branch.data) throw new PosServerError('branch_access_required', 403)
    const staff = await client
      .from('pos_staff')
      .select('role,branch_id')
      .eq('organization_id', branch.data.organization_id)
      .eq('user_id', user.id)
      .eq('active', true)
      .maybeSingle()
    if (staff.error) throw new PosServerError('storage_unavailable', 503)
    if (
      !staff.data ||
      !['owner', 'manager'].includes(staff.data.role) ||
      (staff.data.branch_id && staff.data.branch_id !== query.data.branchId)
    )
      throw new PosServerError('manager_required', 403)
    const products = []
    for (let offset = 0; ; offset += 500) {
      const page = await client
        .from('pos_products')
        .select(
          'id,branch_id,name,category,image_url,barcode,unit,unit_price_fils,tax_rate_bps,active,revision'
        )
        .eq('branch_id', query.data.branchId)
        .order('id')
        .range(offset, offset + 499)
      if (page.error || !page.data) throw new PosServerError('storage_unavailable', 503)
      products.push(
        ...page.data.map((p) =>
          catalogueProductSchema.parse({
            id: p.id,
            branchId: p.branch_id,
            name: p.name,
            category: p.category,
            imageUrl: p.image_url,
            barcode: p.barcode,
            unit: p.unit,
            unitPriceFils: p.unit_price_fils,
            taxRateBps: p.tax_rate_bps,
            active: p.active,
            revision: p.revision,
          })
        )
      )
      if (page.data.length < 500) break
      if (offset >= 100_000) throw new PosServerError('catalogue_too_large', 503)
    }
    return NextResponse.json({ status: 'ready', products }, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}
export async function POST(request: Request) {
  try {
    requirePilot()
    requireOrigin(request)
    const { client, user } = await authenticatedPosClient()
    const parsed = catalogueUpdateSchema.safeParse(JSON.parse(await readBoundedBody(request, 8192)))
    if (!parsed.success) throw new PosServerError('invalid_catalogue_update', 422)
    const binding = await requireDevice(client, parsed.data.branchId, parsed.data.deviceId, user.id)
    const { data, error } = await client.rpc('pos_manage_catalogue', {
      p_command: parsed.data,
      p_binding: binding,
    })
    if (error) {
      if (error.message.includes('POS_CATALOGUE_CONFLICT'))
        throw new PosServerError('catalogue_conflict', 409)
      if (error.message.includes('POS_IDEMPOTENCY_CONFLICT'))
        throw new PosServerError('request_conflict', 409)
      if (
        error.message.includes('POS_ACCESS_DENIED') ||
        error.message.includes('POS_MANAGER_REQUIRED') ||
        error.message.includes('POS_MEDIA_SCOPE') ||
        error.message.includes('POS_DEVICE_INVALID')
      )
        throw new PosServerError('manager_access_required', 403)
      if (
        error.message.includes('POS_INVALID_COMMAND') ||
        error.message.includes('POS_MEDIA_INVALID')
      )
        throw new PosServerError('invalid_catalogue_update', 422)
      throw new PosServerError('storage_unavailable', 503)
    }
    const result = catalogueResultSchema.parse(data)
    if (
      result.requestId !== parsed.data.id ||
      result.product.id !== parsed.data.product.id ||
      result.product.branchId !== parsed.data.branchId
    )
      throw new PosServerError('confirmation_mismatch', 503)
    return NextResponse.json(result, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}

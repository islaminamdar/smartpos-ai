import { resolveMerchantBranding } from '@/lib/pos/server/branding'
import { NextRequest, NextResponse } from 'next/server'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { boundDevice, requirePilot } from '@/lib/pos/server/live-access'
import { liveBootstrapSchema } from '@/lib/pos/server/live-contracts'
import { activeCounterPortal } from '@/lib/pos/server/counter-portal'
export const dynamic = 'force-dynamic'
export async function GET(request: NextRequest) {
  try {
    requirePilot()
    const { client, user } = await authenticatedPosClient()
    const portalSlug = request.nextUrl.searchParams.get('portal')
    const portal = portalSlug ? await activeCounterPortal(portalSlug) : null
    if (portalSlug && !portal) throw new PosServerError('portal_not_found', 404)
    const results = await Promise.all([
      client.from('pos_branches').select('id,organization_id,name').eq('active', true),
      client
        .from('pos_staff')
        .select('organization_id,branch_id,role')
        .eq('user_id', user.id)
        .eq('active', true),
      client.from('pos_branch_receipt_config').select('branch_id,profile_id,live_enabled'),
      client.from('pos_merchant_profiles').select('*'),
      client.rpc('pos_open_shift_summaries'),
    ])
    if (results.some((result) => result.error)) throw new PosServerError('setup_required', 503)
    const [unscopedBranches, staff, configs, profiles] = results
      .slice(0, 4)
      .map((result) => result.data ?? [])
    const branches = portal
      ? unscopedBranches.filter(
          (branch: { id: string; organization_id: string }) =>
            branch.id === portal.branchId && branch.organization_id === portal.organizationId
        )
      : unscopedBranches
    if (
      !Array.isArray(branches) ||
      !branches.length ||
      !Array.isArray(staff) ||
      !Array.isArray(configs) ||
      !Array.isArray(profiles)
    )
      throw new PosServerError(
        portal ? 'portal_access_denied' : 'setup_required',
        portal ? 403 : 503
      )
    const catalogue = []
    for (let offset = 0; ; offset += 500) {
      let query = client
        .from('pos_products')
        .select(
          'id,branch_id,name,category,image_url,barcode,unit,unit_price_fils,tax_rate_bps,revision'
        )
        .eq('active', true)
        .gt('unit_price_fils', 0)
        .order('id')
      if (portal) query = query.eq('branch_id', portal.branchId)
      const page = await query.range(offset, offset + 499)
      if (page.error || !page.data) throw new PosServerError('storage_unavailable', 503)
      catalogue.push(
        ...page.data.map((p) => ({
          id: p.id,
          branchId: p.branch_id,
          name: p.name,
          category: p.category,
          imageUrl: p.image_url,
          barcode: p.barcode,
          unit: p.unit,
          unitPriceFils: p.unit_price_fils,
          taxRateBps: p.tax_rate_bps,
          revision: p.revision,
        }))
      )
      if (page.data.length < 500) break
      if (offset >= 100_000) throw new PosServerError('catalogue_too_large', 503)
    }
    const binding = await boundDevice(client, user.id)
    if (portal && binding?.device.branchId !== portal.branchId)
      throw new PosServerError('portal_device_mismatch', 403)
    const response = liveBootstrapSchema.parse({
      status: 'ready',
      userId: user.id,
      branches: branches.map((b) => {
        const member = staff.find(
          (s) => s.organization_id === b.organization_id && (!s.branch_id || s.branch_id === b.id)
        )
        const config = configs.find((c) => c.branch_id === b.id)
        const p = profiles.find((p) => p.id === config?.profile_id)
        const canManage = member?.role === 'owner' || member?.role === 'manager'
        return {
          id: b.id,
          organizationId: b.organization_id,
          name: b.name,
          role: member?.role,
          branding: resolveMerchantBranding({
            organizationId: b.organization_id,
            branchId: b.id,
            profileId: p?.id ?? null,
          }),
          canRefund: canManage,
          canManageCash: canManage,
          canSell: Boolean(
            config?.live_enabled && p && process.env.POS_LIVE_SALES_ENABLED === 'true'
          ),
          profile: p
            ? {
                id: p.id,
                organizationId: p.organization_id,
                branchId: p.branch_id,
                legalName: p.legal_name,
                branchName: p.branch_name,
                address: p.address,
                phone: p.phone,
                trn: p.trn,
                taxRegistered: p.tax_registered,
                currency: p.currency,
                timezone: p.timezone,
                taxInclusive: p.tax_inclusive,
                calculationVersion: p.calculation_version,
                confirmedBy: p.confirmed_by,
                confirmedAt: p.confirmed_at,
              }
            : null,
        }
      }),
      catalogue,
      device: binding?.device ?? null,
      shifts: portal
        ? (results[4].data ?? []).filter(
            (shift: { branchId: string }) => shift.branchId === portal.branchId
          )
        : (results[4].data ?? []),
      capabilities: {
        onlineSales: process.env.POS_LIVE_SALES_ENABLED === 'true',
        offlineSales: false,
      },
    })
    return NextResponse.json(response, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}

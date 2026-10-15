import { NextResponse } from 'next/server'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'

export const dynamic = 'force-dynamic'
export async function GET() {
  try {
    const { client, user } = await authenticatedPosClient()
    const results = await Promise.all([
      client.from('pos_branches').select('id,organization_id,name,currency,timezone').eq('active', true),
      client.from('pos_products').select('id,organization_id,branch_id,name,category,image_url,unit,unit_price_fils,tax_rate_bps').eq('active', true),
      client.from('pos_devices').select('id,branch_id,name').eq('active', true),
      client.from('pos_shifts').select('id,branch_id,device_id,opened_by,opened_at,opening_cash_fils').eq('status', 'open'),
    ])
    if (results.some(result => result.error)) throw new PosServerError('setup_required', 503)
    const [branches, catalogue, devices, shifts] = results.map(result => result.data)
    if (!branches?.length) throw new PosServerError('setup_required', 503)
    return NextResponse.json({ status: 'ready', userId: user.id, branches, catalogue, devices, shifts }, { headers: privateHeaders })
  } catch (error) { return posFailure(error) }
}

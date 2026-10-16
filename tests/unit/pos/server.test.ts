import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { syncOrderSchema, catalogueLineTotals } from '@/lib/pos/server/contracts'
import { invoice } from '../../fixtures/pos-invoice'
const mocks = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn(), binding: vi.fn() }))
vi.mock('@/lib/pos/server/client', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/pos/server/client')>(), authenticatedPosClient: mocks.auth }))
vi.mock('@/lib/pos/server/live-access', async importOriginal => ({ ...await importOriginal<typeof import('@/lib/pos/server/live-access')>(), requireDevice: mocks.binding }))
import { POST } from '@/app/api/pos/sync/route'
import { PosServerError } from '@/lib/pos/server/client'
const id = invoice.id
const order = { id, branchId:id,deviceId:id,shiftId:id,createdAt:invoice.issuedAt,serviceType:'takeaway',lines:[{productId:id,quantityMilli:1000,expectedUnitPriceFils:300,expectedTaxRateBps:500},{productId:id,quantityMilli:1000,expectedUnitPriceFils:300,expectedTaxRateBps:500}],payments:invoice.payments,expectedTotalFils:600,profileId:id,customer:null,cashTenderedFils:500 }
const request=(body:unknown,origin='http://localhost')=>new NextRequest('http://localhost/api/pos/sync',{method:'POST',body:JSON.stringify(body),headers:{origin,'Content-Type':'application/json'}})
beforeEach(()=>{
  vi.clearAllMocks();vi.unstubAllEnvs();vi.stubEnv('POS_ONLINE_PILOT','true');vi.stubEnv('POS_LIVE_SALES_ENABLED','true')
  mocks.auth.mockResolvedValue({client:{rpc:mocks.rpc},user:{id}});mocks.binding.mockResolvedValue('binding-hash')
})
describe('online sale boundary',()=>{
  it('retains integer catalogue calculations and rejects unsupported foundation fields',()=>{
    expect(catalogueLineTotals(1050,1500,500)).toEqual({grossFils:1575,taxFils:75})
    expect(syncOrderSchema.safeParse({order}).success).toBe(false)
  })
  it('requires pilot financial enablement before touching database',async()=>{
    vi.stubEnv('POS_LIVE_SALES_ENABLED','false');expect((await POST(request({order}))).status).toBe(503);expect(mocks.auth).not.toHaveBeenCalled()
  })
  it('requires authenticated identity and same origin',async()=>{
    expect((await POST(request({order},'https://evil.example'))).status).toBe(403)
    expect((await POST(request({order},''))).status).toBe(403)
    expect(mocks.auth).not.toHaveBeenCalled()
    mocks.auth.mockRejectedValue(new PosServerError('authentication_required',401));expect((await POST(request({order}))).status).toBe(401)
  })
  it('rejects invalid money and device binding before the sale RPC',async()=>{
    expect((await POST(request({order:{...order,expectedTotalFils:1.5}}))).status).toBe(422)
    mocks.binding.mockRejectedValue(new PosServerError('device_binding_required',403));expect((await POST(request({order}))).status).toBe(403)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('requires matching acknowledgement and validated immutable receipt',async()=>{
    mocks.rpc.mockResolvedValue({data:{status:'synced',orderId:id,totalFils:600,taxFils:28,replayed:false,receipt:invoice},error:null})
    const result=await POST(request({order}));expect(result.status).toBe(200);expect(result.headers.get('cache-control')).toBe('private, no-store')
    expect(mocks.rpc).toHaveBeenCalledWith('pos_record_live_order',{p_order:order,p_binding:'binding-hash'})
    mocks.rpc.mockResolvedValue({data:{status:'synced',orderId:id},error:null});expect((await POST(request({order}))).status).toBe(503)
  })
  it('preserves conflicts and hides database diagnostics',async()=>{
    mocks.rpc.mockResolvedValue({data:null,error:{message:'POS_PROFILE_CHANGED'}});expect((await POST(request({order}))).status).toBe(409)
    mocks.rpc.mockResolvedValue({data:null,error:{message:'private diagnostic'}});const result=await POST(request({order}));expect(result.status).toBe(503);expect(JSON.stringify(await result.json())).not.toContain('private diagnostic')
  })
})

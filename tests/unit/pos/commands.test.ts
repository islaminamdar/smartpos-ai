import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { liveCommandSchema } from '@/lib/pos/server/live-contracts'
const mocks=vi.hoisted(()=>({auth:vi.fn(),rpc:vi.fn(),binding:vi.fn()}))
vi.mock('@/lib/pos/server/client',async importOriginal=>({...await importOriginal<typeof import('@/lib/pos/server/client')>(),authenticatedPosClient:mocks.auth}))
vi.mock('@/lib/pos/server/live-access',async importOriginal=>({...await importOriginal<typeof import('@/lib/pos/server/live-access')>(),requireDevice:mocks.binding}))
import { POST } from '@/app/api/pos/commands/route'
import { PosServerError } from '@/lib/pos/server/client'
const id='00000000-0000-4000-8000-000000000001'
const command={id,branchId:id,type:'shift.open',deviceId:id,shiftId:id,openingCashFils:5000}
const request=(value:unknown)=>new NextRequest('http://localhost/api/pos/commands',{method:'POST',body:JSON.stringify(value),headers:{origin:'http://localhost'}})
beforeEach(()=>{vi.clearAllMocks();vi.unstubAllEnvs();vi.stubEnv('POS_ONLINE_PILOT','true');vi.stubEnv('POS_LIVE_SALES_ENABLED','true');mocks.auth.mockResolvedValue({client:{rpc:mocks.rpc},user:{id}});mocks.binding.mockResolvedValue('binding-hash')})
describe('online operational commands',()=>{
  it('rejects arbitrary authority, partial refunds and subscription commands',()=>{
    expect(liveCommandSchema.safeParse({command}).success).toBe(true)
    for(const patch of [{actorId:id},{type:'subscription.update'},{type:'refund.create'},{openingCashFils:-1}]) expect(liveCommandSchema.safeParse({command:{...command,...patch}}).success).toBe(false)
  })
  it('requires identity and binding',async()=>{
    mocks.auth.mockRejectedValueOnce(new PosServerError('authentication_required',401));expect((await POST(request({command}))).status).toBe(401)
    mocks.binding.mockRejectedValueOnce(new PosServerError('device_binding_required',403));expect((await POST(request({command}))).status).toBe(403);expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('passes bound command and requires exact acknowledgement',async()=>{
    mocks.rpc.mockResolvedValue({data:{status:'applied',commandId:id,replayed:false},error:null});expect((await POST(request({command}))).status).toBe(200)
    expect(mocks.rpc).toHaveBeenCalledWith('pos_execute_live_command',{p_command:command,p_binding:'binding-hash'})
    mocks.rpc.mockResolvedValue({data:{status:'applied',commandId:'other'},error:null});expect((await POST(request({command}))).status).toBe(503)
  })
  it('keeps rejected refunds pending and rejects insufficient authority',async()=>{
    mocks.rpc.mockResolvedValue({data:null,error:{message:'POS_PRIOR_REFUND_EXISTS'}});const result=await POST(request({command}));expect(result.status).toBe(409);expect(await result.json()).toMatchObject({status:'pending'})
    mocks.rpc.mockResolvedValue({data:null,error:{message:'POS_MANAGER_REQUIRED'}});expect((await POST(request({command}))).status).toBe(403)
  })
})

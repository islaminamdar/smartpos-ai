import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { posCommandSchema } from '@/lib/pos/server/commands'
const mocks = vi.hoisted(() => ({ createServer: vi.fn(), rpc: vi.fn(), getUser: vi.fn() }))
vi.mock('@/lib/db/supabase', () => ({ createServer: mocks.createServer }))
import { POST } from '@/app/api/pos/commands/route'
const id='00000000-0000-4000-8000-000000000001'
const command={id,branchId:id,type:'shift.open',deviceId:id,shiftId:id,openingCashFils:5000}
const request=(value:unknown)=>new NextRequest('http://localhost/api/pos/commands',{method:'POST',body:JSON.stringify(value)})
beforeEach(()=>{
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://example.supabase.co')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY','public-test-key')
  mocks.createServer.mockResolvedValue({auth:{getUser:mocks.getUser},rpc:mocks.rpc})
  mocks.getUser.mockResolvedValue({data:{user:{id}},error:null})
})
describe('POS operational command API',()=>{
  it('accepts bounded integer money and rejects arbitrary actor, tenant and unsupported commands',()=>{
    expect(posCommandSchema.safeParse({command}).success).toBe(true)
    expect(posCommandSchema.safeParse({command:{...command,actorId:id}}).success).toBe(false)
    expect(posCommandSchema.safeParse({command:{...command,openingCashFils:-1}}).success).toBe(false)
    expect(posCommandSchema.safeParse({command:{...command,type:'discount.approve'}}).success).toBe(false)
  })
  it('does not call the database without authenticated identity',async()=>{
    mocks.getUser.mockResolvedValue({data:{user:null},error:null})
    expect((await POST(request({command}))).status).toBe(401)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('returns required acknowledgements without trusting request-side roles',async()=>{
    mocks.rpc.mockResolvedValue({data:{status:'applied',commandId:id,replayed:false},error:null})
    expect((await POST(request({command}))).status).toBe(200)
    expect(mocks.rpc).toHaveBeenCalledWith('pos_execute_command',{p_command:command})
    mocks.rpc.mockResolvedValue({data:null,error:null})
    expect((await POST(request({command}))).status).toBe(503)
  })
  it('keeps rejected refunds pending and rejects unauthorized subscription changes',async()=>{
    mocks.rpc.mockResolvedValue({data:null,error:{message:'POS_REFUND_LIMIT'}})
    const response=await POST(request({command}))
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({status:'pending',code:'POS_REFUND_LIMIT'})
    mocks.rpc.mockResolvedValue({data:null,error:{message:'POS_ADMIN_REQUIRED'}})
    expect((await POST(request({command}))).status).toBe(403)
  })
})

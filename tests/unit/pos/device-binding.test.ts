import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks=vi.hoisted(()=>({get:vi.fn(),rpc:vi.fn()}))
vi.mock('next/headers',()=>({cookies:async()=>({get:mocks.get})}))
import { boundDevice, hashToken, requireDevice } from '@/lib/pos/server/live-access'
import type { SupabaseClient } from '@supabase/supabase-js'
const actorA='00000000-0000-4000-8000-000000000001'
const actorB='00000000-0000-4000-8000-000000000002'
const client={rpc:mocks.rpc} as unknown as SupabaseClient
beforeEach(()=>{vi.clearAllMocks();mocks.get.mockImplementation((name:string)=>name===`pos-device-${actorA}`?{value:'a'.repeat(64)}:name===`pos-device-${actorB}`?{value:'b'.repeat(64)}:undefined);mocks.rpc.mockResolvedValue({data:{id:actorA,branchId:actorA,name:'Fixture counter'},error:null})})
describe('per-actor opaque device binding',()=>{
  it('preserves the first actor binding after another actor uses the same browser',async()=>{
    await boundDevice(client,actorB);expect(mocks.rpc).toHaveBeenLastCalledWith('pos_bound_device',{p_binding:hashToken('b'.repeat(64))})
    await boundDevice(client,actorA);expect(mocks.rpc).toHaveBeenLastCalledWith('pos_bound_device',{p_binding:hashToken('a'.repeat(64))})
  })
  it('rejects a caller-selected device or branch even with a valid browser token',async()=>{
    await expect(requireDevice(client,actorB,actorA,actorA)).rejects.toMatchObject({code:'device_binding_required'})
    await expect(requireDevice(client,actorA,actorB,actorA)).rejects.toMatchObject({code:'device_binding_required'})
    expect(await requireDevice(client,actorA,actorA,actorA)).toBe(hashToken('a'.repeat(64)))
  })
})

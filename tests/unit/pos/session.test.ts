import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), set: vi.fn(), rpc: vi.fn(), login: vi.fn(), refresh: vi.fn(), getUser: vi.fn(), logout: vi.fn(), from: vi.fn(), limit: vi.fn() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.create }))
vi.mock('next/headers', () => ({ cookies: async () => ({ get: mocks.get, set: mocks.set }) }))
import { POST, DELETE } from '@/app/api/pos/session/route'
import { authenticatedPosClient } from '@/lib/pos/server/client'
const id='00000000-0000-4000-8000-000000000001'
const session={access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600}
const request=(origin='https://pos.example')=>new Request('https://pos.example/api/pos/session',{method:'POST',headers:{origin},body:JSON.stringify({email:'fixture@example.invalid',password:'synthetic-test-password'})})
beforeEach(()=>{
  vi.clearAllMocks();vi.unstubAllEnvs()
  for(const [key,value] of Object.entries({POS_ONLINE_PILOT:'true',POS_PUBLIC_ORIGIN:'https://pos.example',SUPABASE_INTERNAL_URL:'http://127.0.0.1:8046',SUPABASE_ANON_KEY:'synthetic-anon',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service'})) vi.stubEnv(key,value)
  const query={select:()=>query,eq:()=>query,limit:mocks.limit}
  mocks.from.mockReturnValue(query);mocks.limit.mockResolvedValue({data:[{user_id:id}],error:null})
  mocks.create.mockReturnValue({rpc:mocks.rpc,from:mocks.from,auth:{signInWithPassword:mocks.login,getUser:mocks.getUser,refreshSession:mocks.refresh,admin:{signOut:mocks.logout}}})
  mocks.rpc.mockResolvedValue({data:true,error:null});mocks.login.mockResolvedValue({data:{session,user:{id}},error:null});mocks.get.mockReturnValue(undefined)
  mocks.logout.mockResolvedValue({error:null})
})
describe('private online sessions',()=>{
  it('rate limits before password processing and fails closed on unavailable rate store',async()=>{
    mocks.rpc.mockResolvedValueOnce({data:false,error:null});expect((await POST(request())).status).toBe(429);expect(mocks.login).not.toHaveBeenCalled()
    mocks.rpc.mockResolvedValueOnce({data:null,error:{message:'private'}});expect((await POST(request())).status).toBe(503);expect(mocks.login).not.toHaveBeenCalled()
  })
  it('requires origin and private server configuration',async()=>{
    expect((await POST(request('https://evil.example'))).status).toBe(403);expect(mocks.create).not.toHaveBeenCalled()
    vi.stubEnv('SUPABASE_INTERNAL_URL','');expect((await POST(request())).status).toBe(503)
  })
  it('stores session only after checking active POS membership and never returns tokens',async()=>{
    const result=await POST(request());expect(result.status).toBe(200);expect(await result.json()).toEqual({status:'authenticated',userId:id})
    expect(mocks.set).toHaveBeenCalledWith('pos-access','synthetic-access',expect.objectContaining({httpOnly:true,sameSite:'strict',path:'/'}))
    expect(mocks.set).toHaveBeenCalledWith('pos-refresh','synthetic-refresh',expect.objectContaining({httpOnly:true,sameSite:'strict'}))
    const args=mocks.rpc.mock.calls[0][1];expect(args.p_key).toMatch(/^[a-f0-9]{64}$/);expect(JSON.stringify(args)).not.toContain('fixture@')
    mocks.set.mockClear();mocks.limit.mockResolvedValueOnce({data:[],error:null});expect((await POST(request())).status).toBe(403);expect(mocks.set).not.toHaveBeenCalled()
  })
  it('verifies access token with auth server and refreshes expired credentials server-side',async()=>{
    mocks.get.mockImplementation((name:string)=>({value:name==='pos-access'?'expired':'refresh-fixture'}))
    mocks.getUser.mockResolvedValueOnce({data:{user:null},error:{message:'expired'}}).mockResolvedValueOnce({data:{user:{id}},error:null})
    mocks.refresh.mockResolvedValue({data:{session},error:null})
    expect((await authenticatedPosClient()).user.id).toBe(id)
    expect(mocks.refresh).toHaveBeenCalledWith({refresh_token:'refresh-fixture'})
    expect(mocks.getUser).toHaveBeenLastCalledWith('synthetic-access')
  })
  it('revokes refresh session and clears browser cookies on logout',async()=>{
    mocks.get.mockImplementation((name:string)=>name==='pos-access'?{value:'synthetic-access'}:undefined)
    expect((await DELETE(new Request('https://pos.example/api/pos/session',{method:'DELETE',headers:{origin:'https://pos.example'}}))).status).toBe(200)
    expect(mocks.logout).toHaveBeenCalledWith('synthetic-access','local')
    expect(mocks.set).toHaveBeenCalledWith('pos-refresh','',expect.objectContaining({maxAge:0,httpOnly:true}))
  })
})

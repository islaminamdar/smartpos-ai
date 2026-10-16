import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const m=vi.hoisted(()=>({auth:vi.fn(),bound:vi.fn(),from:vi.fn(),rpc:vi.fn(),cookie:vi.fn()}))
vi.mock('next/headers',()=>({cookies:async()=>({get:m.cookie})}))
vi.mock('@/lib/pos/server/client',async(original)=>({...await original<typeof import('@/lib/pos/server/client')>(),authenticatedPosClient:m.auth}))
vi.mock('@/lib/pos/server/live-access',async(original)=>({...await original<typeof import('@/lib/pos/server/live-access')>(),boundDevice:m.bound}))
import { nativeAccess } from '@/lib/pos/server/native-access'
import { GET } from '@/app/api/pos/native/access/route'
import { POST } from '@/app/api/pos/native/device/route'
import { hashToken } from '@/lib/pos/server/live-access'
import { publicReleaseAccess } from '@/lib/pos/public-release'
const id=(n:number)=>`${n}0000000-0000-4000-8000-000000000001`
const actor=id(1),branch=id(2),org=id(3),device=id(4)
let branchRows:unknown[],staffRows:unknown[],dbError:unknown
const request=(body:unknown={branchId:branch,name:'Counter 1'},origin='https://pos.internext.info')=>new Request('https://pos.internext.info/api/pos/native/device',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)})
beforeEach(()=>{
 vi.resetAllMocks();vi.stubEnv('POS_ONLINE_PILOT','true');vi.stubEnv('POS_PUBLIC_ORIGIN','https://pos.internext.info')
 branchRows=[{id:branch,organization_id:org,name:'Fixture branch'}];staffRows=[{organization_id:org,branch_id:branch,role:'manager'}];dbError=null
 m.from.mockImplementation((table:string)=>{const query={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),limit:vi.fn().mockImplementation(async(n:number)=>{expect(n).toBe(501);return{data:table==='pos_branches'?branchRows:staffRows,error:dbError}})};return query})
 m.auth.mockResolvedValue({client:{from:m.from,rpc:m.rpc},user:{id:actor}});m.bound.mockResolvedValue(null)
 m.cookie.mockReturnValue({value:'a'.repeat(64)});m.rpc.mockResolvedValue({data:{id:device,branchId:branch,name:'Counter 1'},error:null})
})
afterEach(()=>vi.unstubAllEnvs())
it('returns only current membership display context without tokens or offline authority',async()=>{
 expect(await nativeAccess()).toEqual({schemaVersion:1,status:'signed_in',actorId:actor,branches:[{id:branch,organizationId:org,name:'Fixture branch',role:'manager'}],device:null,canPrepareOffline:false})
 const response=await GET();expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('no-store')
})
it('filters branches by both organization and assignment',async()=>{
 branchRows.push({id:id(5),organization_id:id(6),name:'Other org'},{id:id(7),organization_id:org,name:'Other branch'})
 expect((await nativeAccess()).branches.map(b=>b.id)).toEqual([branch])
 staffRows=[{organization_id:org,branch_id:null,role:'owner'}];expect((await nativeAccess()).branches.map(b=>b.id)).toEqual([branch,id(7)])
})
it('denies absent memberships and a bound counter outside current branch scope',async()=>{
 staffRows=[];expect((await GET()).status).toBe(403)
 staffRows=[{organization_id:org,branch_id:branch,role:'cashier'}];m.bound.mockResolvedValue({device:{id:device,branchId:id(8),name:'Foreign'},hash:'unused'});expect((await GET()).status).toBe(403)
})
it('fails closed on query errors or possible truncated memberships',async()=>{
 dbError={message:'private backend detail'};expect((await GET()).status).toBe(503);dbError=null
 branchRows=Array.from({length:501},()=>branchRows[0]);expect((await GET()).status).toBe(503)
})
it('enrolls using exactly the hashed persisted binding and safe trimmed name on every retry',async()=>{
 for(let i=0;i<2;i++){const r=await POST(request({branchId:branch,name:' Counter 1 '}));expect(r.status).toBe(200);expect(await r.json()).toEqual({status:'enrolled',device:{id:device,branchId:branch,name:'Counter 1'}});expect(r.headers.get('set-cookie')).toBeNull()}
 expect(m.rpc).toHaveBeenCalledTimes(2);expect(m.rpc).toHaveBeenLastCalledWith('pos_enroll_device',{p_branch:branch,p_name:'Counter 1',p_binding:hashToken('a'.repeat(64))})
 expect(m.cookie).toHaveBeenLastCalledWith(`pos-device-${actor}`)
})
it('requires manager or owner access and same authenticated actor across reads',async()=>{
 staffRows=[{organization_id:org,branch_id:branch,role:'cashier'}];expect((await POST(request())).status).toBe(403);expect(m.rpc).not.toHaveBeenCalled()
 staffRows=[{organization_id:org,branch_id:branch,role:'manager'}];m.auth.mockResolvedValueOnce({client:{from:m.from},user:{id:actor}}).mockResolvedValueOnce({client:{rpc:m.rpc},user:{id:id(8)}});expect((await POST(request())).status).toBe(403);expect(m.rpc).not.toHaveBeenCalled()
})
it('never generates a replacement binding when absent or malformed',async()=>{
 for(const value of [undefined,'short','A'.repeat(64),'b'.repeat(65)]){m.cookie.mockReturnValue(value?{value}:undefined);expect((await POST(request())).status).toBe(422)}expect(m.rpc).not.toHaveBeenCalled()
})
it('rejects cross-origin, overlong and unknown input before enrolling',async()=>{
 expect((await POST(request(undefined,'https://evil.invalid'))).status).toBe(403)
 for(const body of [{branchId:branch,name:'x'.repeat(81)},{branchId:branch,name:'Counter',actorId:actor},{branchId:'invalid',name:'Counter'},{branchId:branch,name:'x'.repeat(2048)}])expect((await POST(request(body))).status).not.toBe(200)
 expect(m.rpc).not.toHaveBeenCalled()
})
it('rejects foreign returned device and sanitizes backend errors',async()=>{
 m.rpc.mockResolvedValueOnce({data:{id:device,branchId:id(8),name:'Wrong'},error:null});expect((await POST(request())).status).toBe(409)
 m.rpc.mockResolvedValueOnce({data:null,error:{message:'POS_DEVICE_ALREADY_BOUND private detail'}});const r=await POST(request());expect(r.status).toBe(409);expect(await r.text()).not.toContain('private detail')
})
it('keeps both endpoints behind exact pilot and method gates',async()=>{
 for(const [path,method] of [['/api/pos/native/access','GET'],['/api/pos/native/device','POST']]){expect(publicReleaseAccess(path,method,true)).toBe('allow');expect(publicReleaseAccess(path,method,false)).toBe('unavailable');expect(publicReleaseAccess(path+'/extra',method,true)).not.toBe('allow');expect(publicReleaseAccess(path,'DELETE',true)).not.toBe('allow')}
 vi.stubEnv('POS_ONLINE_PILOT','false');expect((await GET()).status).toBe(503);expect((await POST(request())).status).toBe(503);expect(m.auth).not.toHaveBeenCalled()
})

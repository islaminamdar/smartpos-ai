// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ auth: vi.fn(), device: vi.fn(), recovery: vi.fn(), rpc: vi.fn(), limit: vi.fn() }))
vi.mock('@/lib/pos/server/client', async original => ({ ...await original<typeof import('@/lib/pos/server/client')>(), authenticatedPosClient: m.auth }))
vi.mock('@/lib/pos/server/live-access', async original => ({ ...await original<typeof import('@/lib/pos/server/live-access')>(), requireDevice: m.device, recoveryBinding: m.recovery }))
vi.mock('@/lib/pos/offline/server', () => ({ limitOfflineRecovery: m.limit }))
import { encodeBase64Url, canonicalBytes, sha256Hex } from '@/lib/pos/offline/canonical'
import { verifySignedEnvelope } from '@/lib/pos/offline/authority'
import { nativeShiftClose, nativeShiftCloseContextSchema, nativeShiftCloseOutcomeSchema } from '@/lib/pos/offline/native-shift-close'
import { POST } from '@/app/api/pos/native/shift-close/route'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const scope = { actorId:id(1),organizationId:id(2),branchId:id(3),deviceId:id(4),shiftId:id(5) }
const command = {id:id(6),type:'shift.close',branchId:scope.branchId,deviceId:scope.deviceId,shiftId:scope.shiftId,countedCashFils:12345}
const context = {mode:'context',challenge:'a'.repeat(64),branchId:scope.branchId,deviceId:scope.deviceId,shiftId:scope.shiftId}
const request = (mode='execute') => ({mode,challenge:'b'.repeat(64),command})
let keys:CryptoKeyPair,contextRow:Record<string,unknown>,outcome:Record<string,unknown>
const post=(body:unknown=request(),origin='https://pos.example.test')=>new Request('https://pos.example.test/api/pos/native/shift-close',{method:'POST',headers:{origin},body:typeof body==='string'?body:JSON.stringify(body)})
beforeEach(async()=>{
 vi.resetAllMocks()
 for(const flag of ['POS_ONLINE_PILOT','POS_LIVE_SALES_ENABLED','POS_OFFLINE_ISSUANCE_ENABLED'])vi.stubEnv(flag,'true')
 vi.stubEnv('POS_PUBLIC_ORIGIN','https://pos.example.test')
 keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify'])
 vi.stubEnv('POS_OFFLINE_SIGNING_KEY_ID','server')
 vi.stubEnv('POS_OFFLINE_SERVER_KEYS',JSON.stringify([{id:'server',publicKeySpki:encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki',keys.publicKey))),privateKeyPkcs8:encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8',keys.privateKey)))}]))
 contextRow={...scope,status:'open',canClose:true,reasonCode:null}
 outcome={...scope,commandId:command.id,countedCashFils:command.countedCashFils,status:'applied',result:{commandId:command.id,shiftId:command.shiftId,countedCashFils:command.countedCashFils,expectedCashFils:12000,cashDifferenceFils:345,closedAt:'2026-10-16T10:00:00.000Z'}}
 m.auth.mockResolvedValue({user:{id:scope.actorId},client:{rpc:m.rpc}});m.device.mockResolvedValue('current-binding');m.recovery.mockResolvedValue('historical-binding')
 m.rpc.mockImplementation(async(name)=>({data:name==='pos_native_shift_close_context'?contextRow:name==='pos_native_shift_close_lookup'?outcome:{status:'applied',commandId:command.id},error:null}))
})
afterEach(()=>vi.unstubAllEnvs())
it('signs original empty-shift context without creating an allocation or command',async()=>{
 const r=await nativeShiftClose(context),{payload}=await verifySignedEnvelope(r.handoff,nativeShiftCloseContextSchema,{server:keys.publicKey})
 expect(payload).toMatchObject({...scope,challenge:context.challenge,canClose:true,purpose:'close-shift'})
 expect(m.rpc).toHaveBeenCalledExactlyOnceWith('pos_native_shift_close_context',{p_branch:scope.branchId,p_device:scope.deviceId,p_shift:scope.shiftId,p_binding:'current-binding'})
})
it('executes exact existing command then signs independently read original result',async()=>{
 const r=await nativeShiftClose(request()),{payload}=await verifySignedEnvelope(r.handoff,nativeShiftCloseOutcomeSchema,{server:keys.publicKey})
 expect(m.rpc.mock.calls.map(c=>c[0])).toEqual(['pos_execute_live_command','pos_native_shift_close_lookup'])
 for(const [,args]of m.rpc.mock.calls)expect(args).toEqual({p_command:command,p_binding:'current-binding'})
 expect(payload).toMatchObject({...outcome,requestSha256:await sha256Hex(canonicalBytes(command)),challenge:'b'.repeat(64)})
})
it.each(['applied','not_found','cancelled'])('lookup %s is read-only with sales and pilot disabled',async status=>{
 for(const flag of ['POS_ONLINE_PILOT','POS_LIVE_SALES_ENABLED','POS_OFFLINE_ISSUANCE_ENABLED'])vi.stubEnv(flag,'false')
 outcome.status=status;if(status!=='applied')outcome.result=null
 const r=await nativeShiftClose(request('lookup'))
 expect((await verifySignedEnvelope(r.handoff,nativeShiftCloseOutcomeSchema,{server:keys.publicKey})).payload.status).toBe(status)
 expect(m.device).not.toHaveBeenCalled();expect(m.rpc).toHaveBeenCalledExactlyOnceWith('pos_native_shift_close_lookup',{p_command:command,p_binding:'historical-binding'})
})
it('a signing configuration failure cannot close a drawer',async()=>{
 vi.stubEnv('POS_OFFLINE_SERVER_KEYS','[]')
 await expect(nativeShiftClose(request())).rejects.toMatchObject({code:'offline_signing_unavailable'})
 expect(m.rpc).not.toHaveBeenCalled()
})
it('a lost post-write readback remains uncertain and subsequent lookup never repeats the close',async()=>{
 m.rpc.mockImplementationOnce(async()=>({data:null,error:null})).mockImplementationOnce(async()=>({data:null,error:{message:'storage interrupted'}}))
 await expect(nativeShiftClose(request())).rejects.toMatchObject({status:503})
 m.rpc.mockClear();await nativeShiftClose(request('lookup'))
 expect(m.rpc).toHaveBeenCalledTimes(1);expect(m.rpc.mock.calls[0][0]).toBe('pos_native_shift_close_lookup')
})
it.each(['actorId','branchId','deviceId','shiftId','commandId','countedCashFils'])('rejects wrong result scope %s',async field=>{
 outcome[field]=field==='countedCashFils'?1:id(99)
 await expect(nativeShiftClose(request('lookup'))).rejects.toMatchObject({status:503})
})
it('rejects contradictory status, amounts, extra fields and malformed completion date',async()=>{
 const original=structuredClone(outcome)
 for(const patch of [{cashDifferenceFils:1},{expectedCashFils:Number.MAX_SAFE_INTEGER+1},{countedCashFils:12344},{commandId:id(99)},{closedAt:'2026-02-31T00:00:00.000Z'},{extra:true}]){
  outcome={...original,result:{...(original.result as object),...patch}}
  await expect(nativeShiftClose(request('lookup'))).rejects.toMatchObject({status:503})
 }
 outcome={...original,status:'not_found'};await expect(nativeShiftClose(request('lookup'))).rejects.toMatchObject({status:503})
 outcome={...original,status:'not_found',result:null};await expect(nativeShiftClose(request())).rejects.toMatchObject({status:503})
})
it('accepts negative expected cash only with an exact safe signed difference',async()=>{
 outcome.result={...(outcome.result as object),expectedCashFils:-100,cashDifferenceFils:12445}
 const r=await nativeShiftClose(request('lookup'));expect((await verifySignedEnvelope(r.handoff,nativeShiftCloseOutcomeSchema,{server:keys.publicKey})).payload.result?.cashDifferenceFils).toBe(12445)
})
it('readiness cannot bypass paused selling, and offline flag is not authority to strand an empty shift',async()=>{
 vi.stubEnv('POS_LIVE_SALES_ENABLED','false')
 const r=await nativeShiftClose(context);expect((await verifySignedEnvelope(r.handoff,nativeShiftCloseContextSchema,{server:keys.publicKey})).payload).toMatchObject({canClose:false,reasonCode:'shift_close_unavailable'})
 m.rpc.mockClear();await expect(nativeShiftClose(request())).rejects.toMatchObject({status:503});expect(m.rpc).not.toHaveBeenCalled()
 vi.stubEnv('POS_LIVE_SALES_ENABLED','true');vi.stubEnv('POS_OFFLINE_ISSUANCE_ENABLED','false');await expect(nativeShiftClose(request())).resolves.toHaveProperty('handoff')
})
it('rejects context contradictions and signed unknown blocker codes',async()=>{
 for(const patch of [{status:'closed',canClose:true,reasonCode:null},{status:'open',canClose:false,reasonCode:null},{canClose:false,reasonCode:'new_untrusted_reason'},{actorId:id(99)}]){
  contextRow={...scope,status:'open',canClose:true,reasonCode:null,...patch};await expect(nativeShiftClose(context)).rejects.toMatchObject({status:503})
 }
})
it('route enforces origin, byte limit, strict commands and private responses',async()=>{
 expect((await POST(post(request(),'https://wrong.example.test'))).status).toBe(403)
 expect((await POST(post('é'.repeat(513)))).status).toBe(413)
 for(const body of [{...request(),actorId:scope.actorId},{...request(),command:{...command,type:'cash.move'}},{...request(),command:{...command,countedCashFils:1.1}}])expect((await POST(post(body))).status).toBe(422)
 expect(m.rpc).not.toHaveBeenCalled()
 const response=await POST(post(request('lookup')));expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('no-store')
})
it('does not leak storage details and cannot turn a financial hold into a successful close',async()=>{
 m.rpc.mockResolvedValueOnce({data:null,error:{message:'POS_OFFLINE_PAYMENT_HOLD'}})
 expect((await POST(post())).status).toBe(409)
 m.rpc.mockResolvedValueOnce({data:null,error:{message:'private database contents'}})
 const response=await POST(post());expect(response.status).toBe(503);expect(await response.text()).not.toContain('private database')
})

// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { z } from 'zod'
const m=vi.hoisted(()=>({rpc:vi.fn(),password:vi.fn(),revoke:vi.fn(),auth:vi.fn()}))
vi.mock('@/lib/pos/server/client',async original=>({...await original<typeof import('@/lib/pos/server/client')>(),
  authenticatedPosClient:m.auth,posClient:()=>({rpc:m.rpc,auth:{signInWithPassword:m.password,admin:{signOut:m.revoke}}})}))
import fixture from '../../../fixtures/pos-offline-output.json'
import { readPaymentReview, decidePaymentReview, listPaymentReviews, paymentReviewActor } from '@/lib/pos/offline/payment-review'
import { offlinePaymentFreezeSchema } from '@/lib/pos/offline/payment-contracts'
import { offlinePaymentResolutionSchema, paymentDecisionRequestSchema, type PaymentDecisionRequest, type OfflinePaymentResolution } from '@/lib/pos/offline/payment-review-contracts'
import { canonicalBytes, canonicalJson, encodeBase64Url, sha256Hex } from '@/lib/pos/offline/canonical'
import { publicKeyFingerprint, signEnvelope, verifySignedEnvelope } from '@/lib/pos/offline/authority'
import type { OfflineAuthority, OfflineSnapshot, SignedEnvelope } from '@/lib/pos/offline/contracts'
const id=(n:number)=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`
const digest=(value:unknown)=>sha256Hex(canonicalBytes(value))
const user={id:id(90),email:'synthetic-manager@example.test'}
const http=()=>new Request('http://127.0.0.1:3099/api/pos/manager/offline-payments/resolve',{method:'POST',headers:{Origin:'http://127.0.0.1:3099'}})
let server:CryptoKeyPair,device:CryptoKeyPair,authority:OfflineAuthority,snapshot:OfflineSnapshot,freeze:z.infer<typeof offlinePaymentFreezeSchema>,
  authorityRow:Record<string,unknown>,detail:Record<string,any>,command:PaymentDecisionRequest
const makeResolution=async(request:PaymentDecisionRequest):Promise<OfflinePaymentResolution>=>offlinePaymentResolutionSchema.parse({
  kind:'offline-payment-resolution',schemaVersion:1,purpose:'reconciliation-only',resolutionId:id(91),requestId:request.requestId,
  freezeId:freeze.freezeId,freezeSha256:await digest(freeze),paymentIntentId:freeze.paymentIntentId,requestSha256:freeze.requestSha256,
  orderId:freeze.orderId,documentId:freeze.documentId,organizationId:freeze.organizationId,branchId:freeze.branchId,deviceId:freeze.deviceId,
  actorId:freeze.actorId,shiftId:freeze.shiftId,keyEpoch:freeze.keyEpoch,authorityId:freeze.authorityId,authoritySha256:freeze.authoritySha256,
  snapshotSha256:freeze.snapshotSha256,managerActorId:user.id,decision:request.decision,evidenceSha256:await digest(request.evidence),resolvedAt:new Date().toISOString(),replacement:null})
let onRpc:(name:string,args:Record<string,any>)=>Promise<{data:any,error:any}>
beforeEach(async()=>{
  vi.resetAllMocks()
  for(const flag of ['POS_OFFLINE_PAYMENT_REVIEW_ENABLED','POS_OFFLINE_PAYMENT_RESOLUTION_ENABLED'])vi.stubEnv(flag,'true')
  for(const flag of ['POS_ONLINE_PILOT','POS_LIVE_SALES_ENABLED','POS_OFFLINE_ISSUANCE_ENABLED'])vi.stubEnv(flag,'false')
  vi.stubEnv('POS_PUBLIC_ORIGIN','http://127.0.0.1:3099');vi.stubEnv('POS_LOGIN_SOURCE_MODE','loopback-development')
  server=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify'])
  device=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify'])
  vi.stubEnv('POS_OFFLINE_SIGNING_KEY_ID','synthetic-server')
  vi.stubEnv('POS_OFFLINE_SERVER_KEYS',JSON.stringify([{id:'synthetic-server',publicKeySpki:encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki',server.publicKey))),privateKeyPkcs8:encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8',server.privateKey)))}]))
  snapshot=structuredClone(fixture.bundle.snapshot) as OfflineSnapshot
  authority={...structuredClone(fixture.bundle.authority),deviceKeySha256:await publicKeyFingerprint(device.publicKey)} as OfflineAuthority
  authority.snapshotSha256=await digest(snapshot)
  authorityRow={snapshot,authority,snapshotSha256:authority.snapshotSha256,authoritySha256:await digest(authority),keyEpoch:authority.keyEpoch,deviceId:authority.deviceId,
    publicKeySpki:encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki',device.publicKey))),snapshotEnvelope:await signEnvelope(snapshot,'synthetic-server',server.privateKey),authorityEnvelope:await signEnvelope(authority,'synthetic-server',server.privateKey)}
  const request={authorityId:authority.id,serviceType:'takeaway' as const,customer:null,lines:[{productId:snapshot.products[0].id,quantityMilli:1000}],cashTenderedFils:1500,recordedCardFils:0,presentedTotalFils:1000}
  freeze={kind:'offline-payment-freeze',schemaVersion:1,freezeId:id(1),paymentIntentId:id(2),orderId:id(3),documentId:id(4),organizationId:authority.organizationId,
    branchId:authority.branchId,deviceId:authority.deviceId,actorId:authority.actorId,shiftId:authority.shiftId,keyEpoch:authority.keyEpoch,deviceKeySha256:authority.deviceKeySha256,
    authorityId:authority.id,authoritySha256:authorityRow.authoritySha256 as string,snapshotSha256:authority.snapshotSha256,requestSha256:await digest(request),request,
    intentCreatedAt:authority.issuedAt,chainHead:{sequence:0,eventSha256:null},observation:null,declaration:'local-intent-unissued-and-permanently-frozen'}
  const quote={calculationVersion:'offline-line-v1',lines:[{lineNumber:1,productId:snapshot.products[0].id,name:snapshot.products[0].name,unit:'piece',quantityMilli:1000,unitPriceFils:1000,taxRateBps:500,grossFils:1000,netFils:952,taxFils:48}],
    totals:{grossFils:1000,netFils:952,taxFils:48},payments:[{method:'cash',amountFils:1000}],cashTenderedFils:1500,changeFils:500,requiresBuyerDetails:false}
  detail={summary:{caseId:freeze.freezeId,caseKind:'freeze',freezeId:freeze.freezeId,freezeSha256:await digest(freeze),authorityId:authority.id,paymentIntentId:freeze.paymentIntentId,orderId:freeze.orderId,
    documentId:freeze.documentId,branchId:authority.branchId,deviceId:authority.deviceId,deviceName:'Synthetic counter',actorId:authority.actorId,shiftId:authority.shiftId,
    recordedAt:'2026-10-16T00:00:00.000123Z',state:'pending',grossFils:1000,cashFils:1000,cardFils:0,decision:null,resolutionId:null},
    freezeEnvelope:await signEnvelope(freeze,authority.deviceKeySha256,device.privateKey),request,quote,conflicts:[],conflictsTruncated:false,
    decisionRequest:null,resolution:null,resolutionEnvelope:null,capabilities:{policyEnabled:true,originalShiftOpen:true,canDecide:true,holdCode:null}}
  command={requestId:id(7),freezeId:freeze.freezeId,freezeSha256:await digest(freeze),decision:'funds_returned',reason:'Completed synthetic cash return',cashDrawerShiftId:authority.shiftId,
    evidence:[{method:'cash',amountFils:1000,paymentObservedAt:new Date(Date.now()-6000).toISOString(),completedAt:new Date(Date.now()-3000).toISOString(),reference:'Synthetic drawer receipt',note:'Full net amount returned after change'}]}
  m.auth.mockResolvedValue({user});m.password.mockResolvedValue({data:{user,session:{access_token:'temporary-synthetic-token'}},error:null});m.revoke.mockResolvedValue({error:null})
  onRpc=async(name,args)=>{
    if(name==='pos_offline_authority')return{data:authorityRow,error:null}
    if(name==='pos_offline_payment_detail'){expect(args).toEqual({p_actor:user.id,p_branch:authority.branchId,p_case:freeze.freezeId,p_kind:'freeze'});return{data:structuredClone(detail),error:null}}
    if(name==='pos_login_attempt'||name==='pos_offline_manager_limit')return{data:true,error:null}
    if(name==='pos_offline_payment_list')return{data:{cases:[detail.summary],nextCursor:{recordedAt:detail.summary.recordedAt,caseId:freeze.freezeId,caseKind:'freeze'}},error:null}
    if(name==='pos_offline_payment_decide'){
      expect(args.p_actor).toBe(user.id);expect(args.p_request).toEqual(command)
      detail.decisionRequest=structuredClone(command);detail.resolution=await makeResolution(command)
      detail.summary={...detail.summary,state:'delivery_pending',decision:command.decision,resolutionId:id(91)}
      detail.capabilities={...detail.capabilities,canDecide:false,holdCode:'decision_recorded'}
      return{data:{resolution:detail.resolution,resolutionEnvelope:null,replayed:false},error:null}
    }
    if(name==='pos_offline_payment_attach'){
      expect(args.p_resolution).toBe(id(91));detail.resolutionEnvelope??=args.p_envelope
      return{data:{resolution:detail.resolution,resolutionEnvelope:detail.resolutionEnvelope},error:null}
    }
    throw new Error('Unexpected test RPC '+name)
  }
  m.rpc.mockImplementation((...args)=>onRpc(args[0],args[1]))
})
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();vi.useRealTimers()})
const read=()=>readPaymentReview(user.id,authority.branchId,freeze.freezeId,'freeze')
const decide=()=>decidePaymentReview(http(),user,authority.branchId,command,'Synthetic password never stored')
it('reads verified historical evidence and preserves microsecond cursor precision with selling paused',async()=>{
  expect(await paymentReviewActor(http())).toEqual(user)
  const result=await read();expect(result.freeze).toEqual(freeze);expect(result.quote).toEqual(detail.quote);expect(result.capabilities.canDecide).toBe(true)
  expect(result.nativeDelivery).toBe('not_implemented')
  const list=await listPaymentReviews(user.id,authority.branchId,null)
  await listPaymentReviews(user.id,authority.branchId,list.nextCursor)
  expect(m.rpc.mock.calls.at(-1)?.[1].p_cursor.recordedAt).toBe('2026-10-16T00:00:00.000123Z')
  expect(m.password).not.toHaveBeenCalled()
})
it('requires current role, exact scope, untouched quote and genuine historical device signature before exposing a case',async()=>{
  const original=structuredClone(detail),normal=onRpc
  onRpc=async(name,args)=>name==='pos_offline_payment_detail'?{data:null,error:{message:'POS_MANAGER_REQUIRED'}}:normal(name,args)
  await expect(read()).rejects.toMatchObject({code:'offline_review_forbidden',status:403})
  expect(m.rpc.mock.calls.some(([name])=>name==='pos_offline_authority')).toBe(false);onRpc=normal
  for(const mutate of [(d:any)=>d.summary.branchId=id(99),(d:any)=>d.summary.grossFils=1,(d:any)=>d.quote.lines[0].name='Repriced product',(d:any)=>d.request.cashTenderedFils=1600]){
    detail=structuredClone(original);mutate(detail);await expect(read()).rejects.toThrow()
  }
  detail=structuredClone(original);detail.freezeEnvelope=await signEnvelope(freeze,authority.deviceKeySha256,server.privateKey)
  await expect(read()).rejects.toMatchObject({code:'offline_device_proof_invalid'})
  expect(m.password).not.toHaveBeenCalled()
})
it('reauthenticates exact current account, revokes only temporary session, commits once and verifies first server signature',async()=>{
  const result=await decide();expect(result.status).toBe('recorded');expect(result.nativeDelivery).toBe('not_implemented')
  expect(m.password).toHaveBeenCalledWith({email:user.email,password:'Synthetic password never stored'})
  expect(m.revoke).toHaveBeenCalledWith('temporary-synthetic-token','local')
  expect((await verifySignedEnvelope(result.resolutionEnvelope!,offlinePaymentResolutionSchema,{'synthetic-server':server.publicKey})).payload).toEqual(result.resolution)
  const calls=m.rpc.mock.calls.map(([name])=>name);expect(calls.indexOf('pos_login_attempt')).toBeLessThan(calls.indexOf('pos_offline_payment_decide'))
  expect(JSON.stringify(m.rpc.mock.calls)).not.toContain('Synthetic password never stored')
  expect(await decide()).toEqual(result)
  expect(m.password).toHaveBeenCalledTimes(1);expect(m.rpc.mock.calls.filter(([name])=>name==='pos_offline_payment_decide')).toHaveLength(1)
})
it.each(['wrong-password','wrong-user','cleanup-failure','rate-limited'])('does not decide after %s',async(mode)=>{
  if(mode==='wrong-password')m.password.mockResolvedValue({data:{user:null,session:null},error:{message:'private'}})
  if(mode==='wrong-user')m.password.mockResolvedValue({data:{user:{id:id(99)},session:{access_token:'other-temporary-token'}},error:null})
  if(mode==='cleanup-failure')m.revoke.mockResolvedValue({error:{message:'private'}})
  if(mode==='rate-limited'){const normal=onRpc;onRpc=async(name,args)=>name==='pos_login_attempt'?{data:false,error:null}:normal(name,args)}
  await expect(decide()).rejects.toThrow()
  expect(m.rpc.mock.calls.some(([name])=>name==='pos_offline_payment_decide')).toBe(false)
  if(mode==='wrong-user')expect(m.revoke).toHaveBeenCalledWith('other-temporary-token','local')
})
it('captures confirmation before slow session cleanup and lets SQL reject its expired age',async()=>{
  const now=Date.now();vi.useFakeTimers();vi.setSystemTime(now)
  m.revoke.mockImplementation(async()=>{vi.setSystemTime(now+121_000);return{error:null}})
  const normal=onRpc
  onRpc=async(name,args)=>{
    if(name==='pos_offline_payment_decide'){expect(args.p_confirmed_at).toBe(new Date(now).toISOString());return{data:null,error:{message:'POS_OFFLINE_CONFIRMATION_REQUIRED'}}}
    return normal(name,args)
  }
  await expect(decide()).rejects.toMatchObject({code:'manager_confirmation_required',status:401})
  expect(detail.resolution).toBeNull()
})
it.each(['amount','future','drawer','void-cash','hidden-text','unknown-field'])('rejects invalid %s evidence before password or decision',async(mode)=>{
  if(mode==='amount')command.evidence[0].amountFils=1500
  if(mode==='future')command.evidence[0].completedAt=new Date(Date.now()+60_000).toISOString()
  if(mode==='drawer')command.cashDrawerShiftId=id(99)
  if(mode==='void-cash')command.decision='payment_voided'
  if(mode==='hidden-text')command.reason='A\u0000B'
  if(mode==='unknown-field')Object.assign(command,{managerActorId:id(99)})
  await expect(decide()).rejects.toThrow();expect(m.password).not.toHaveBeenCalled()
})
it('keeps a committed decision delivery-pending on signing failure and recovers only its exact result',async()=>{
  const sign=crypto.subtle.sign.bind(crypto.subtle)
  const spy=vi.spyOn(crypto.subtle,'sign').mockImplementation(async(...args)=>{
    if(new TextDecoder().decode(args[2] as ArrayBuffer).includes('offline-payment-resolution'))throw new Error('Synthetic interrupted signer')
    return sign(...args)
  })
  const result=await decide();expect(result.status).toBe('delivery_pending');expect(result.resolutionEnvelope).toBeNull()
  spy.mockRestore();vi.stubEnv('POS_OFFLINE_PAYMENT_RESOLUTION_ENABLED','false')
  const recovered=await read();expect(recovered.resolution).toEqual(result.resolution);expect(recovered.resolutionEnvelope).not.toBeNull()
  expect(recovered.summary.state).toBe('resolved');expect(recovered.capabilities.canDecide).toBe(false)
  expect(m.password).toHaveBeenCalledTimes(1);expect(m.rpc.mock.calls.filter(([name])=>name==='pos_offline_payment_decide')).toHaveLength(1)
})
it('never accepts another payload or an untrusted signature as the stored resolution',async()=>{
  await decide();const original=structuredClone(detail)
  detail.resolution.managerActorId=id(99)
  await expect(read()).rejects.toThrow()
  detail=structuredClone(original);detail.resolutionEnvelope=await signEnvelope(detail.resolution,'synthetic-server',device.privateKey)
  await expect(read()).rejects.toMatchObject({code:'offline_storage_unavailable'})
})
it('keeps global or branch-disabled new decisions unavailable while preserving historical reads',async()=>{
  vi.stubEnv('POS_OFFLINE_PAYMENT_RESOLUTION_ENABLED','false')
  expect((await read()).capabilities.canDecide).toBe(false)
  await expect(decide()).rejects.toMatchObject({code:'offline_resolution_not_enabled'})
  expect(m.password).not.toHaveBeenCalled()
  vi.stubEnv('POS_OFFLINE_PAYMENT_REVIEW_ENABLED','false')
  await expect(paymentReviewActor(http())).rejects.toMatchObject({code:'offline_review_not_enabled'})
})
it('maps late database role revocation and conflicts without reporting a recorded decision',async()=>{
  const normal=onRpc
  for(const [sql,code,status] of [['POS_ACCESS_DENIED','offline_review_forbidden',403],['POS_OFFLINE_PAYMENT_CONFLICT','offline_payment_conflict',409],['POS_OFFLINE_DRAWER_INVALID','offline_original_drawer_closed',409],['POS_OFFLINE_DECISION_INVALID','invalid_payment_decision',422]] as const){
    onRpc=async(name,args)=>name==='pos_offline_payment_decide'?{data:null,error:{message:sql}}:normal(name,args)
    await expect(decide()).rejects.toMatchObject({code,status});expect(detail.resolution).toBeNull()
  }
})
it('does not allow changed request bodies to reuse an accepted decision',async()=>{
  await decide();command={...command,reason:'Changed assertion'}
  await expect(decide()).rejects.toMatchObject({code:'offline_decision_conflict'})
  expect(m.rpc.mock.calls.filter(([name])=>name==='pos_offline_payment_decide')).toHaveLength(1)
})
it('rejects replacement invoices and unsupported confirmation fields in manager requests',()=>{
  expect(paymentDecisionRequestSchema.safeParse({...command,decision:'current_time_invoice'}).success).toBe(false)
  expect(paymentDecisionRequestSchema.safeParse({...command,confirmedAt:new Date().toISOString()}).success).toBe(false)
})

// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ auth: vi.fn(), access: vi.fn(), device: vi.fn(), rpc: vi.fn(), serviceRpc: vi.fn() }))
vi.mock('@/lib/pos/server/client', async original => ({ ...await original<typeof import('@/lib/pos/server/client')>(),
  authenticatedPosClient: m.auth, posClient: () => ({ rpc: m.serviceRpc }) }))
vi.mock('@/lib/pos/server/native-access', () => ({ nativeAccess: m.access }))
vi.mock('@/lib/pos/server/live-access', async original => ({ ...await original<typeof import('@/lib/pos/server/live-access')>(), requireDevice: m.device }))
import fixture from '../../../fixtures/pos-offline-output.json'
import { canonicalBytes, encodeBase64Url, sha256Hex } from '@/lib/pos/offline/canonical'
import { publicKeyFingerprint, signEnvelope, verifyOfflineBundle, verifySignedEnvelope } from '@/lib/pos/offline/authority'
import { nativeOfflineContext, prepareNativeOffline, nativeOfflineContextSchema, nativeOfflinePreparedSchema } from '@/lib/pos/offline/native-preparation'
import { POST as contextPost } from '@/app/api/pos/native/preparation/route'
import { POST as preparePost } from '@/app/api/pos/native/prepare/route'
import type { SignedEnvelope } from '@/lib/pos/offline/contracts'

const original = fixture.reservation.authority, other = '00000000-0000-4000-8000-000000000099'
const challenge = 'a'.repeat(64), challenge2 = 'b'.repeat(64)
const contextRequest = { challenge, branchId: original.branchId, deviceId: original.deviceId }
const reservation = { requestId: original.id, branchId: original.branchId, deviceId: original.deviceId, shiftId: original.shiftId,
  count: 3, lifetimeSeconds: 3600, maxInvoiceTotalFils: 100000, maxGrossFils: 300000, permissions: original.permissions }
const prepareRequest = { challenge, reservation }
let trusted: Record<string, CryptoKey>, snapshot: typeof fixture.reservation.snapshot, authority: typeof original,
  snapshotEnvelope: SignedEnvelope, authorityEnvelope: SignedEnvelope, key: CryptoKey, deviceSpki: string,
  shifts: unknown[], access: {actorId:string;branches:{id:string;organizationId:string}[];device:{id:string;branchId:string}|null}, now: number
const request = (body: unknown, origin = 'https://pos.internext.info') => new Request('https://pos.internext.info/api/pos/native/preparation',
  {method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)})
beforeEach(async () => {
  vi.resetAllMocks(); now=1_792_132_000_000; vi.spyOn(Date,'now').mockImplementation(()=>now)
  for (const flag of ['POS_ONLINE_PILOT','POS_LIVE_SALES_ENABLED','POS_OFFLINE_ISSUANCE_ENABLED']) vi.stubEnv(flag,'true')
  vi.stubEnv('POS_PUBLIC_ORIGIN','https://pos.internext.info')
  const server=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify'])
  const device=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify'])
  key=server.privateKey; trusted={'test-server':server.publicKey}
  deviceSpki=encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki',device.publicKey)))
  vi.stubEnv('POS_OFFLINE_SIGNING_KEY_ID','test-server')
  vi.stubEnv('POS_OFFLINE_SERVER_KEYS',JSON.stringify([{id:'test-server',publicKeySpki:encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki',server.publicKey))),privateKeyPkcs8:encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8',key)))}]))
  snapshot=structuredClone(fixture.reservation.snapshot);authority={...structuredClone(original),deviceKeySha256:await publicKeyFingerprint(device.publicKey)}
  const snapshotSha256=await sha256Hex(canonicalBytes(snapshot))
  snapshotEnvelope=await signEnvelope(snapshot,'test-server',key)
  authorityEnvelope=await signEnvelope({...authority,snapshotSha256},'test-server',key)
  access={actorId:original.actorId,branches:[{id:original.branchId,organizationId:original.organizationId}],device:{id:original.deviceId,branchId:original.branchId}}
  m.access.mockImplementation(async()=>access);m.auth.mockResolvedValue({user:{id:original.actorId},client:{rpc:m.rpc}});m.device.mockResolvedValue('binding')
  shifts=[{id:original.shiftId,branchId:original.branchId,deviceId:original.deviceId,openedBy:original.actorId,openedAt:original.issuedAt,openingCashFils:0,expectedCashFils:-100}]
  m.rpc.mockImplementation(async(name)=>{expect(name).toBe('pos_open_shift_summaries');return{data:shifts,error:null}})
  m.serviceRpc.mockImplementation(async(name)=>{
    if(name==='pos_offline_reserve')return{data:{snapshot,authority},error:null}
    expect(name).toBe('pos_offline_attach');now+=10
    const bundle=await verifyOfflineBundle(snapshotEnvelope,authorityEnvelope,trusted)
    return{data:{...bundle,snapshotEnvelope,authorityEnvelope,publicKeySpki:deviceSpki,keyEpoch:authority.keyEpoch,deviceId:authority.deviceId},error:null}
  })
})
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs()})

it('signs exact SQL-derived own-shift context with real P-256 crypto',async()=>{
  const result=await nativeOfflineContext(contextRequest)
  expect(Object.keys(result)).toEqual(['handoff'])
  const {payload}=await verifySignedEnvelope(result.handoff,nativeOfflineContextSchema,trusted)
  expect(payload).toEqual({kind:'native-offline-context',schemaVersion:1,challenge,serverTimeMs:now,actorId:original.actorId,organizationId:original.organizationId,branchId:original.branchId,deviceId:original.deviceId,shiftId:original.shiftId})
  expect(m.device).toHaveBeenCalledWith(expect.anything(),original.branchId,original.deviceId,original.actorId)
  expect(m.serviceRpc).not.toHaveBeenCalled()
})
it('returns null for no own shift, never borrows another actor or device shift',async()=>{
  const row=shifts[0] as Record<string,unknown>
  shifts=[{...row,openedBy:other},{...row,deviceId:other},{...row,branchId:other}]
  expect((await verifySignedEnvelope((await nativeOfflineContext(contextRequest)).handoff,nativeOfflineContextSchema,trusted)).payload.shiftId).toBeNull()
  await expect(prepareNativeOffline(prepareRequest)).rejects.toMatchObject({code:'native_shift_required'})
  expect(m.serviceRpc).not.toHaveBeenCalled()
})
it('rejects ambiguous, malformed or unavailable shift summaries',async()=>{
  shifts.push(shifts[0]);await expect(nativeOfflineContext(contextRequest)).rejects.toMatchObject({code:'native_preparation_unavailable'})
  shifts=[{...(shifts[0] as object),unexpected:true}];await expect(nativeOfflineContext(contextRequest)).rejects.toMatchObject({code:'native_preparation_unavailable'})
  m.rpc.mockResolvedValue({data:[],error:{message:'private backend detail'}});const r=await contextPost(request(contextRequest));expect(r.status).toBe(503);expect(await r.text()).not.toContain('private backend')
})
it('rejects unbound, foreign branch/device and changing authenticated actor before reservation',async()=>{
  const saved=access.device
  for(const device of [null,{...saved!,id:other},{...saved!,branchId:other}]){access.device=device;await expect(prepareNativeOffline(prepareRequest)).rejects.toMatchObject({status:403})}
  access.device=saved;access.branches=[];await expect(nativeOfflineContext(contextRequest)).rejects.toMatchObject({status:403})
  access.branches=[{id:original.branchId,organizationId:original.organizationId}];m.auth.mockResolvedValue({user:{id:other},client:{rpc:m.rpc}})
  await expect(prepareNativeOffline(prepareRequest)).rejects.toMatchObject({code:'access_denied'});expect(m.serviceRpc).not.toHaveBeenCalled()
})
it('honors a revoked cookie binding and requested own shift before allocating',async()=>{
  m.device.mockRejectedValueOnce(new Error('revoked binding'));await expect(prepareNativeOffline(prepareRequest)).rejects.toThrow('revoked binding')
  await expect(prepareNativeOffline({...prepareRequest,reservation:{...reservation,shiftId:other}})).rejects.toMatchObject({code:'native_shift_required'})
  expect(m.serviceRpc).not.toHaveBeenCalled()
})
it.each(['POS_ONLINE_PILOT','POS_LIVE_SALES_ENABLED','POS_OFFLINE_ISSUANCE_ENABLED'])('gates both routes before authentication: %s',async(flag)=>{
  vi.stubEnv(flag,'false');expect((await contextPost(request(contextRequest))).status).toBe(503);expect((await preparePost(request(prepareRequest))).status).toBe(503)
  expect(m.access).not.toHaveBeenCalled();expect(m.serviceRpc).not.toHaveBeenCalled()
})
it('rejects origin, oversized body, unknown fields and noncanonical challenges before auth',async()=>{
  expect((await contextPost(request(contextRequest,'https://evil.invalid'))).status).toBe(403)
  expect((await preparePost(request(prepareRequest,'https://evil.invalid'))).status).toBe(403)
  expect((await contextPost(request({extra:'x'.repeat(1025)}))).status).toBe(413)
  expect((await preparePost(request({extra:'x'.repeat(8193)}))).status).toBe(413)
  for(const body of [{...contextRequest,challenge:'A'.repeat(64)},{...contextRequest,challenge:'a'.repeat(63)},{...contextRequest,actorId:original.actorId},{...contextRequest,branchId:'invalid'}])expect((await contextPost(request(body))).status).toBe(422)
  expect((await preparePost(request({...prepareRequest,actorId:other}))).status).toBe(422);expect(m.access).not.toHaveBeenCalled()
})
it('uses actual reserve/sign/attach service and signs verified hashes at post-reservation time',async()=>{
  const before=now,result=await prepareNativeOffline(prepareRequest)
  expect(Object.keys(result).sort()).toEqual(['authorityEnvelope','handoff','snapshotEnvelope'])
  const bundle=await verifyOfflineBundle(result.snapshotEnvelope,result.authorityEnvelope,trusted)
  const {payload}=await verifySignedEnvelope(result.handoff,nativeOfflinePreparedSchema,trusted)
  expect(payload).toEqual({kind:'native-offline-prepared',schemaVersion:1,challenge,serverTimeMs:before+10,actorId:original.actorId,organizationId:original.organizationId,branchId:original.branchId,deviceId:original.deviceId,shiftId:original.shiftId,keyEpoch:authority.keyEpoch,deviceKeySha256:authority.deviceKeySha256,authorityId:original.id,snapshotSha256:bundle.snapshotSha256,authoritySha256:bundle.authoritySha256})
  expect(m.serviceRpc.mock.calls.map(([name])=>name)).toEqual(['pos_offline_reserve','pos_offline_attach'])
})
it('refreshes challenge/time without changing durable identity, original envelopes or expiry on retry',async()=>{
  const first=await prepareNativeOffline(prepareRequest);now+=5000
  const second=await prepareNativeOffline({...prepareRequest,challenge:challenge2})
  expect(second.snapshotEnvelope).toEqual(first.snapshotEnvelope);expect(second.authorityEnvelope).toEqual(first.authorityEnvelope)
  const a=(await verifySignedEnvelope(first.handoff,nativeOfflinePreparedSchema,trusted)).payload,b=(await verifySignedEnvelope(second.handoff,nativeOfflinePreparedSchema,trusted)).payload
  expect(b.challenge).toBe(challenge2);expect(b.serverTimeMs).toBeGreaterThan(a.serverTimeMs);expect(b.authoritySha256).toBe(a.authoritySha256)
  for(const [,args] of m.serviceRpc.mock.calls.filter(([name])=>name==='pos_offline_reserve'))expect(args).toEqual({p_actor:original.actorId,p_request:reservation})
})
it('does not bless a correctly signed bundle from another organization',async()=>{
  access.branches[0].organizationId=other
  await expect(prepareNativeOffline(prepareRequest)).rejects.toMatchObject({code:'offline_storage_unavailable'})
})
it('fails closed on unsigned or altered bundle envelopes and absent signing configuration',async()=>{
  authorityEnvelope={...authorityEnvelope,payloadBase64Url:snapshotEnvelope.payloadBase64Url}
  expect((await preparePost(request(prepareRequest))).status).toBe(503)
  m.serviceRpc.mockClear();vi.stubEnv('POS_OFFLINE_SERVER_KEYS','')
  expect((await contextPost(request(contextRequest))).status).toBe(503);expect((await preparePost(request(prepareRequest))).status).toBe(503);expect(m.serviceRpc).not.toHaveBeenCalled()
})
it('keeps challenge and hash substitution detectable and marks responses no-store',async()=>{
  const response=await preparePost(request(prepareRequest));expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store')
  const data=await response.json(),verified=await verifySignedEnvelope(data.handoff,nativeOfflinePreparedSchema,trusted)
  const altered={...data.handoff,payloadBase64Url:encodeBase64Url(canonicalBytes({...verified.payload,challenge:challenge2}))}
  await expect(verifySignedEnvelope(altered,nativeOfflinePreparedSchema,trusted)).rejects.toThrow()
  expect(nativeOfflinePreparedSchema.safeParse({...verified.payload,unknown:true}).success).toBe(false)
  expect(nativeOfflineContextSchema.safeParse({...verified.payload,kind:'native-offline-context'}).success).toBe(false)
})

it('bounds server time to the native year-9999 ceiling',()=>{
  const valid={kind:'native-offline-context',schemaVersion:1,challenge,serverTimeMs:253402300799999,actorId:original.actorId,organizationId:original.organizationId,branchId:original.branchId,deviceId:original.deviceId,shiftId:null}
  expect(nativeOfflineContextSchema.safeParse(valid).success).toBe(true)
  expect(nativeOfflineContextSchema.safeParse({...valid,serverTimeMs:253402300800000}).success).toBe(false)
})

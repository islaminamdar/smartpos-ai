// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const m=vi.hoisted(()=>({rpc:vi.fn(),auth:vi.fn()}))
vi.mock('@/lib/pos/server/client',async original=>({...await original<typeof import('@/lib/pos/server/client')>(),authenticatedPosClient:m.auth,posClient:()=>({rpc:m.rpc})}))
import fixture from '../../../fixtures/pos-offline-output.json'
import { recoverOfflineBundle, nativeOfflineRecoveredSchema, offlineBundleRecoveryProofSchema } from '@/lib/pos/offline/bundle-recovery'
import { nativeOfflinePreparedSchema } from '@/lib/pos/offline/native-preparation'
import { publicKeyFingerprint, signEnvelope, verifyOfflineBundle, verifySignedEnvelope } from '@/lib/pos/offline/authority'
import { canonicalBytes, encodeBase64Url, sha256Hex } from '@/lib/pos/offline/canonical'
import { POST } from '@/app/api/pos/offline/bundle-recovery/route'
import type { OfflineAuthority, OfflineSnapshot, SignedEnvelope } from '@/lib/pos/offline/contracts'
let server:CryptoKeyPair,device:CryptoKeyPair,snapshot:OfflineSnapshot,authority:OfflineAuthority,row:Record<string,unknown>,draft:Record<string,unknown>,trusted:Record<string,CryptoKey>
const challenge='a'.repeat(64),other='00000000-0000-4000-8000-000000000099'
async function proof(extra:Record<string,unknown>={},key?:CryptoKey,keyId?:string){return signEnvelope({kind:'offline-bundle-recovery',schemaVersion:1,authorityId:authority.id,keyEpoch:authority.keyEpoch,deviceId:authority.deviceId,challenge,...extra},keyId??authority.deviceKeySha256,key??device.privateKey)}
const req=(body:unknown)=>new Request('https://pos.internext.info/api/pos/offline/bundle-recovery',{method:'POST',headers:{'content-type':'application/json','x-forwarded-for':'203.0.113.10'},body:JSON.stringify(body)})
beforeEach(async()=>{
  vi.resetAllMocks();m.auth.mockRejectedValue(new Error('Current access revoked'))
  for(const flag of ['POS_ONLINE_PILOT','POS_LIVE_SALES_ENABLED','POS_OFFLINE_ISSUANCE_ENABLED'])vi.stubEnv(flag,'false')
  vi.stubEnv('POS_LOGIN_SOURCE_MODE','apache-rightmost')
  server=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);device=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);trusted={'server-v1':server.publicKey}
  vi.stubEnv('POS_OFFLINE_SIGNING_KEY_ID','server-v1');vi.stubEnv('POS_OFFLINE_SERVER_KEYS',JSON.stringify([{id:'server-v1',publicKeySpki:encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki',server.publicKey))),privateKeyPkcs8:encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8',server.privateKey)))}]))
  snapshot=structuredClone(fixture.bundle.snapshot) as OfflineSnapshot;authority={...structuredClone(fixture.bundle.authority),deviceKeySha256:await publicKeyFingerprint(device.publicKey)} as OfflineAuthority
  row={snapshot,authority,snapshotEnvelope:await signEnvelope(snapshot,'server-v1',server.privateKey),authorityEnvelope:await signEnvelope(authority,'server-v1',server.privateKey),snapshotSha256:await sha256Hex(canonicalBytes(snapshot)),authoritySha256:await sha256Hex(canonicalBytes(authority)),publicKeySpki:encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki',device.publicKey))),keyEpoch:authority.keyEpoch,deviceId:authority.deviceId}
  draft={...row,authority:{...authority,snapshotSha256:null},snapshotEnvelope:null,authorityEnvelope:null,snapshotSha256:null,authoritySha256:null}
  m.rpc.mockImplementation(async(name)=>({data:name==='pos_offline_limit'?true:row,error:null}))
})
afterEach(()=>vi.unstubAllEnvs())
it('accepts a valid near-limit snapshot whose transport envelope and reader row exceed one MiB',async()=>{
  snapshot.products=Array.from({length:1800},(_,index)=>({id:`${(index+1).toString(16).padStart(8,'0')}-0000-4000-8000-000000000001`,name:'n'.repeat(220),category:'c'.repeat(100),unit:'piece' as const,unitPriceFils:1000,taxRateBps:500,revision:1}))
  const bytes=canonicalBytes(snapshot);expect(bytes.length).toBeLessThanOrEqual(1_048_576)
  authority.snapshotSha256=await sha256Hex(bytes)
  row={...row,snapshot,authority,snapshotSha256:authority.snapshotSha256,authoritySha256:await sha256Hex(canonicalBytes(authority)),snapshotEnvelope:await signEnvelope(snapshot,'server-v1',server.privateKey),authorityEnvelope:await signEnvelope(authority,'server-v1',server.privateKey)}
  expect(JSON.stringify(row.snapshotEnvelope).length).toBeGreaterThan(1_048_576)
  const recovered=await recoverOfflineBundle(await proof());expect(recovered.snapshotEnvelope).toEqual(row.snapshotEnvelope)
  expect((await verifyOfflineBundle(recovered.snapshotEnvelope,recovered.authorityEnvelope,trusted)).snapshot.products).toHaveLength(1800)
})
it('returns original signed historical bytes with distinct reconciliation-only challenge proof while all gates are off',async()=>{
  const result=await recoverOfflineBundle(await proof()),bundle=await verifyOfflineBundle(result.snapshotEnvelope,result.authorityEnvelope,trusted)
  expect(result.snapshotEnvelope).toEqual(row.snapshotEnvelope);expect(result.authorityEnvelope).toEqual(row.authorityEnvelope);expect(bundle.authority).toEqual(authority)
  const {payload}=await verifySignedEnvelope(result.handoff,nativeOfflineRecoveredSchema,trusted)
  expect(payload).toEqual({kind:'native-offline-recovered',schemaVersion:1,purpose:'reconciliation-only',challenge,serverTimeMs:expect.any(Number),actorId:authority.actorId,organizationId:authority.organizationId,branchId:authority.branchId,deviceId:authority.deviceId,shiftId:authority.shiftId,keyEpoch:authority.keyEpoch,deviceKeySha256:authority.deviceKeySha256,authorityId:authority.id,snapshotSha256:row.snapshotSha256,authoritySha256:row.authoritySha256})
  expect(nativeOfflinePreparedSchema.safeParse(payload).success).toBe(false);expect(m.auth).not.toHaveBeenCalled();expect(m.rpc.mock.calls.map(([name])=>name)).toEqual(['pos_offline_authority'])
})
it('finishes interrupted attachment only after possession proof, without reserving or renewing',async()=>{
  m.rpc.mockImplementation(async(name,args)=>{
    if(name==='pos_offline_authority')return{data:draft,error:null}
    expect(name).toBe('pos_offline_attach');expect(args.p_authority).toBe(authority.id)
    const attached=await verifyOfflineBundle(args.p_snapshot_envelope,args.p_authority_envelope,trusted);expect(attached.snapshot).toEqual(snapshot);expect(attached.authority).toEqual(authority)
    return{data:row,error:null} // Another signer won; first stored signature bytes are authoritative.
  })
  const result=await recoverOfflineBundle(await proof());expect(result.authorityEnvelope).toEqual(row.authorityEnvelope);expect(result.snapshotEnvelope).toEqual(row.snapshotEnvelope)
  expect(m.rpc.mock.calls.map(([name])=>name)).toEqual(['pos_offline_authority','pos_offline_attach']);expect(m.auth).not.toHaveBeenCalled()
})
it('rejects forged, other-device, other-epoch and other-authority proofs before attachment',async()=>{
  m.rpc.mockResolvedValue({data:draft,error:null})
  for(const signed of [await proof({},server.privateKey),await proof({deviceId:other}),await proof({keyEpoch:other}),await proof({authorityId:other}),await proof({},device.privateKey,'unknown-key')]){
    await expect(recoverOfflineBundle(signed)).rejects.toMatchObject({code:'offline_device_proof_invalid',status:403})
  }
  expect(m.rpc.mock.calls.every(([name])=>name==='pos_offline_authority')).toBe(true)
})
it('requires a pre-existing authority and never treats absence as permission to allocate',async()=>{
  m.rpc.mockResolvedValue({data:null,error:null});await expect(recoverOfflineBundle(await proof())).rejects.toMatchObject({code:'offline_authority_unavailable',status:404});expect(m.rpc).toHaveBeenCalledTimes(1)
})
it('rejects partial attachment, altered stored hashes/scope and unknown draft fields',async()=>{
  for(const bad of [{...draft,snapshotEnvelope:row.snapshotEnvelope},{...row,authoritySha256:'0'.repeat(64)},{...draft,keyEpoch:other},{...draft,deviceId:other},{...draft,authority:{...draft.authority as object,unexpected:true}},{...draft,publicKeySpki:encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki',server.publicKey)))}]){
    m.rpc.mockResolvedValue({data:bad,error:null});await expect(recoverOfflineBundle(await proof())).rejects.toMatchObject({code:'offline_storage_unavailable'})
  }
  expect(m.rpc.mock.calls.every(([name])=>name==='pos_offline_authority')).toBe(true)
})
it('cannot bless a changed or unsigned attachment readback',async()=>{
  m.rpc.mockImplementation(async(name)=>({data:name==='pos_offline_authority'?draft:{...row,authorityEnvelope:{...row.authorityEnvelope as SignedEnvelope,payloadBase64Url:(row.snapshotEnvelope as SignedEnvelope).payloadBase64Url}},error:null}))
  await expect(recoverOfflineBundle(await proof())).rejects.toMatchObject({code:'offline_storage_unavailable'})
})
it('preserves original budget and expiry while varying only challenge response on repeated recovery',async()=>{
  const first=await recoverOfflineBundle(await proof()),second=await recoverOfflineBundle(await proof({challenge:'b'.repeat(64)}))
  expect(second.authorityEnvelope).toEqual(first.authorityEnvelope);expect(second.snapshotEnvelope).toEqual(first.snapshotEnvelope)
  const a=(await verifySignedEnvelope(first.handoff,nativeOfflineRecoveredSchema,trusted)).payload,b=(await verifySignedEnvelope(second.handoff,nativeOfflineRecoveredSchema,trusted)).payload
  expect(b.challenge).not.toBe(a.challenge);expect(b.authoritySha256).toBe(a.authoritySha256);expect(m.rpc.mock.calls.every(([name])=>name==='pos_offline_authority')).toBe(true)
})
it('limits source before parsing any payload and returns no-store responses without login or Origin',async()=>{
  const response=await POST(req(await proof()));expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('private, no-store');expect(m.rpc.mock.calls[0][0]).toBe('pos_offline_limit');expect(m.auth).not.toHaveBeenCalled()
  m.rpc.mockClear();m.rpc.mockResolvedValue({data:false,error:null});const denied=await POST(req('invalid envelope'));expect(denied.status).toBe(429);expect(m.rpc.mock.calls.map(([name])=>name)).toEqual(['pos_offline_limit'])
})
it('bounds streamed body and rejects strict proof unknown fields before history lookup',async()=>{
  expect((await POST(req('a'.repeat(16385)))).status).toBe(413);expect(m.rpc.mock.calls.map(([name])=>name)).toEqual(['pos_offline_limit']);m.rpc.mockClear()
  await expect(recoverOfflineBundle(await proof({issuedAt:'2026-10-16T00:00:00.000Z'}))).rejects.toThrow();expect(m.rpc).not.toHaveBeenCalled()
  expect(offlineBundleRecoveryProofSchema.safeParse({kind:'offline-bundle-recovery',schemaVersion:1,authorityId:authority.id,keyEpoch:authority.keyEpoch,deviceId:authority.deviceId,challenge:'A'.repeat(64)}).success).toBe(false)
})
it('fails closed with unavailable signing configuration and enforces native clock upper bound',async()=>{
  vi.stubEnv('POS_OFFLINE_SERVER_KEYS','');await expect(recoverOfflineBundle(await proof())).rejects.toMatchObject({code:'offline_signing_unavailable'});expect(m.rpc).not.toHaveBeenCalled()
  const payload={kind:'native-offline-recovered',schemaVersion:1,purpose:'reconciliation-only',challenge,serverTimeMs:253402300799999,actorId:authority.actorId,organizationId:authority.organizationId,branchId:authority.branchId,deviceId:authority.deviceId,shiftId:authority.shiftId,keyEpoch:authority.keyEpoch,deviceKeySha256:authority.deviceKeySha256,authorityId:authority.id,snapshotSha256:row.snapshotSha256,authoritySha256:row.authoritySha256}
  expect(nativeOfflineRecoveredSchema.safeParse(payload).success).toBe(true);expect(nativeOfflineRecoveredSchema.safeParse({...payload,serverTimeMs:253402300800000}).success).toBe(false)
})

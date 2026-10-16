// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ rpc: vi.fn(), auth: vi.fn() }))
vi.mock('@/lib/pos/server/client', async original => ({
  ...await original<typeof import('@/lib/pos/server/client')>(),
  authenticatedPosClient: m.auth, posClient: () => ({ rpc: m.rpc }),
}))
import { invoice } from '../../../fixtures/pos-invoice'
import { canonicalBytes, decodeBase64Url, encodeBase64Url, parseCanonicalPayload, sha256Hex } from '@/lib/pos/offline/canonical'
import { publicKeyFingerprint, signEnvelope } from '@/lib/pos/offline/authority'
import { enrollOfflineDevice, importOfflineReceipt, reserveOfflineAuthority, sealOfflineAuthority, limitOfflineRecovery } from '@/lib/pos/offline/server'
import { offlineServerKeys } from '@/lib/pos/offline/server-keys'
import type { OfflineAuthority, OfflineSnapshot, SignedEnvelope } from '@/lib/pos/offline/contracts'

const id = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000002'
const at = '2026-10-16T10:00:00.000Z'
async function fixture() {
  const server = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign','verify'])
  const device = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign','verify'])
  const publicKeySpki = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', device.publicKey)))
  const fingerprint = await publicKeyFingerprint(device.publicKey)
  const config = [{ id: 'server-v1', publicKeySpki: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', server.publicKey))),
    privateKeyPkcs8: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', server.privateKey))) }]
  vi.stubEnv('POS_OFFLINE_SERVER_KEYS', JSON.stringify(config)); vi.stubEnv('POS_OFFLINE_SIGNING_KEY_ID','server-v1')
  const document = { ...structuredClone(invoice), issuedAt: at, lines: invoice.lines.map((line,i) => ({ ...line, productId: i ? other : id })) }
  const snapshot: OfflineSnapshot = { kind:'offline-snapshot',schemaVersion:1,id,organizationId:id,branchId:id,createdAt:at,
    profile:document.merchant,calculationVersion:'offline-line-v1',offers:[],products:document.lines.map(line=>({id:line.productId,name:line.name,category:'Synthetic',unit:line.unit,unitPriceFils:line.unitPriceFils,taxRateBps:line.taxRateBps,revision:1})) }
  const snapshotSha256=await sha256Hex(canonicalBytes(snapshot))
  const authority: OfflineAuthority={kind:'offline-authority',schemaVersion:1,id,organizationId:id,branchId:id,deviceId:id,actorId:id,
    deviceKeySha256:fingerprint,keyEpoch:id,shiftId:id,snapshotId:id,snapshotSha256,issuedAt:at,notBefore:at,expiresAt:'2026-10-16T22:00:00.000Z',
    invoiceRange:{prefix:'TEST',first:1,last:100},maxInvoiceTotalFils:100_000,maxGrossFils:10_000_000,permissions:{cash:true,recordedCard:true,mixedTender:true},policy:{refunds:'online-only',sharedTabs:'online-only',offers:'online-only'}}
  const authoritySha256=await sha256Hex(canonicalBytes(authority))
  const row={snapshot,authority,snapshotEnvelope:await signEnvelope(snapshot,'server-v1',server.privateKey),authorityEnvelope:await signEnvelope(authority,'server-v1',server.privateKey),snapshotSha256,authoritySha256,publicKeySpki,keyEpoch:id,deviceId:id}
  const issuance={kind:'offline-sale',schemaVersion:1,id,authorityId:id,authoritySha256,snapshotSha256,deviceSequence:1,previousEventSha256:null,document,clock:{estimatedServerAt:at,bootId:id,elapsedRealtimeMs:25},paymentIntentId:id}
  const envelope=await signEnvelope(issuance,fingerprint,device.privateKey)
  const request={requestId:id,branchId:id,deviceId:id,shiftId:id,count:100,lifetimeSeconds:43200,maxInvoiceTotalFils:100_000,maxGrossFils:10_000_000,permissions:authority.permissions}
  const enrollment={requestId:id,branchId:id,deviceId:id,publicKeySpki,deviceKeySha256:fingerprint,proof:await signEnvelope({kind:'offline-enrollment',schemaVersion:1,requestId:id,branchId:id,deviceId:id,actorId:id,deviceKeySha256:fingerprint,issuedAt:at},fingerprint,device.privateKey)}
  return {server,device,config,row,issuance,envelope,request,enrollment,fingerprint}
}
beforeEach(()=>{
  vi.clearAllMocks(); m.auth.mockResolvedValue({user:{id}})
  vi.stubEnv('POS_ONLINE_PILOT','true');vi.stubEnv('POS_LIVE_SALES_ENABLED','true');vi.stubEnv('POS_OFFLINE_ISSUANCE_ENABLED','true')
})
afterEach(()=>vi.unstubAllEnvs())

describe('offline server trust and reservation',()=>{
  it('fails closed before storage mutation if disabled or signing config is absent',async()=>{
    const f=await fixture();vi.stubEnv('POS_OFFLINE_ISSUANCE_ENABLED','false')
    await expect(reserveOfflineAuthority(f.request)).rejects.toMatchObject({code:'offline_issuance_not_enabled'})
    vi.stubEnv('POS_OFFLINE_ISSUANCE_ENABLED','true');vi.stubEnv('POS_OFFLINE_SERVER_KEYS','')
    await expect(reserveOfflineAuthority(f.request)).rejects.toMatchObject({code:'offline_signing_unavailable'})
    expect(m.rpc).not.toHaveBeenCalled()
  })
  it('rejects mismatched signing pairs and repeated key IDs before allocation',async()=>{
    const f=await fixture(); f.config[0].publicKeySpki=f.row.publicKeySpki
    vi.stubEnv('POS_OFFLINE_SERVER_KEYS',JSON.stringify(f.config))
    await expect(offlineServerKeys()).rejects.toMatchObject({code:'offline_signing_unavailable'})
    vi.stubEnv('POS_OFFLINE_SERVER_KEYS',JSON.stringify([f.config[0],f.config[0]]))
    await expect(offlineServerKeys()).rejects.toMatchObject({code:'offline_signing_unavailable'})
  })
  it('binds enrollment to the authenticated manager and actual proof-of-possession key',async()=>{
    const f=await fixture();m.rpc.mockResolvedValue({data:{keyEpoch:id,deviceId:id,deviceKeySha256:f.fingerprint,publicKeySpki:f.row.publicKeySpki},error:null})
    expect(await enrollOfflineDevice(f.enrollment)).toMatchObject({keyEpoch:id})
    expect(m.rpc).toHaveBeenLastCalledWith('pos_offline_enroll',{p_actor:id,p_request:f.enrollment})
    m.rpc.mockClear();m.auth.mockResolvedValue({user:{id:other}})
    await expect(enrollOfflineDevice(f.enrollment)).rejects.toMatchObject({code:'offline_device_proof_invalid'})
    expect(m.rpc).not.toHaveBeenCalled()
  })
  it('rejects substituted public keys before enrolling anything',async()=>{
    const f=await fixture();f.enrollment.publicKeySpki=f.config[0].publicKeySpki
    await expect(enrollOfflineDevice(f.enrollment)).rejects.toMatchObject({code:'offline_device_proof_invalid'})
    expect(m.rpc).not.toHaveBeenCalled()
  })
  it('signs reserved historical bytes and returns the first database-cached envelopes',async()=>{
    const f=await fixture()
    m.rpc.mockImplementation(async name=>({data:name==='pos_offline_reserve'?{snapshot:f.row.snapshot,authority:{...f.row.authority,snapshotSha256:null}}:f.row,error:null}))
    const result=await reserveOfflineAuthority(f.request)
    expect(result).toEqual({snapshotEnvelope:f.row.snapshotEnvelope,authorityEnvelope:f.row.authorityEnvelope})
    const attached=m.rpc.mock.calls.find(([name])=>name==='pos_offline_attach')![1]
    expect(parseCanonicalPayload(decodeBase64Url(attached.p_authority_envelope.payloadBase64Url))).toEqual(f.row.authority)
  })
  it('rejects a storage response with changed branch/limits before attaching authority',async()=>{
    const f=await fixture();m.rpc.mockResolvedValue({data:{snapshot:f.row.snapshot,authority:{...f.row.authority,snapshotSha256:null,maxGrossFils:1}},error:null})
    await expect(reserveOfflineAuthority(f.request)).rejects.toMatchObject({code:'offline_storage_unavailable'})
    expect(m.rpc).toHaveBeenCalledTimes(1)
  })
})

describe('historical offline custody',()=>{
  it('accepts original evidence with no current login and all selling flags off, returning original ACK on retry',async()=>{
    const f=await fixture();let original:SignedEnvelope|undefined
    vi.stubEnv('POS_ONLINE_PILOT','false');vi.stubEnv('POS_LIVE_SALES_ENABLED','false');vi.stubEnv('POS_OFFLINE_ISSUANCE_ENABLED','false')
    m.auth.mockRejectedValue(new Error('revoked staff'))
    m.rpc.mockImplementation(async(name,args)=>{
      if(name==='pos_offline_authority')return {data:f.row,error:null}
      const replayed=!!original; original??=args.p_ack_envelope
      return {data:{status:'accepted',acknowledgement:original,receipt:f.issuance.document,replayed},error:null}
    })
    const first=await importOfflineReceipt(f.envelope),second=await importOfflineReceipt(f.envelope)
    expect(first).toMatchObject({status:'accepted',replayed:false});expect(second).toMatchObject({status:'accepted',replayed:true})
    expect('acknowledgement' in first && first.acknowledgement).toEqual('acknowledgement' in second && second.acknowledgement)
    expect(m.auth).not.toHaveBeenCalled()
  })
  it('does not let forged device evidence write or quarantine an authority',async()=>{
    const f=await fixture();m.rpc.mockResolvedValue({data:f.row,error:null})
    const forged=await signEnvelope(f.issuance,f.fingerprint,f.server.privateKey)
    await expect(importOfflineReceipt(forged)).rejects.toMatchObject({code:'offline_device_proof_invalid'})
    expect(m.rpc.mock.calls.map(([name])=>name)).toEqual(['pos_offline_authority'])
  })
  it('retains a device-signed financial anomaly instead of creating a receipt or ACK',async()=>{
    const f=await fixture();f.issuance.document.totals.grossFils++
    const invalid=await signEnvelope(f.issuance,f.fingerprint,f.device.privateKey)
    m.rpc.mockImplementation(async name=>({data:name==='pos_offline_authority'?f.row:{status:'reconciliation_required',exceptionId:other,code:'invalid_historical_receipt'},error:null}))
    expect(await importOfflineReceipt(invalid)).toMatchObject({status:'reconciliation_required'})
    expect(m.rpc.mock.calls.map(([name])=>name)).toEqual(['pos_offline_authority','pos_offline_reject'])
  })
  it('rejects corrupted stored history and mismatched signed ACKs',async()=>{
    const f=await fixture();m.rpc.mockResolvedValue({data:{...f.row,authoritySha256:'0'.repeat(64)},error:null})
    await expect(importOfflineReceipt(f.envelope)).rejects.toMatchObject({code:'offline_storage_unavailable'})
    m.rpc.mockImplementation(async(name,args)=>{
      if(name==='pos_offline_authority')return {data:f.row,error:null}
      const ack=parseCanonicalPayload(decodeBase64Url(args.p_ack_envelope.payloadBase64Url)) as Record<string,unknown>
      return {data:{status:'accepted',acknowledgement:await signEnvelope({...ack,payloadSha256:'0'.repeat(64)},'server-v1',f.server.privateKey),receipt:f.issuance.document,replayed:false},error:null}
    })
    await expect(importOfflineReceipt(f.envelope)).rejects.toMatchObject({code:'offline_acknowledgement_invalid'})
  })
  it('seals only the signed historical epoch/device and validates the returned final chain',async()=>{
    const f=await fixture();const seal={kind:'offline-seal',schemaVersion:1,id:other,authorityId:id,keyEpoch:id,deviceId:id,finalSequence:0,finalEventSha256:null}
    m.rpc.mockImplementation(async name=>({data:name==='pos_offline_authority'?f.row:{status:'sealed',authorityId:id,finalSequence:0,finalEventSha256:null},error:null}))
    expect(await sealOfflineAuthority(await signEnvelope(seal,f.fingerprint,f.device.privateKey))).toMatchObject({status:'sealed'})
    await expect(sealOfflineAuthority(await signEnvelope({...seal,deviceId:other},f.fingerprint,f.device.privateKey))).rejects.toMatchObject({code:'offline_device_proof_invalid'})
  })
  it('uses the trusted source budget and distinguishes throttling from storage failure',async()=>{
    vi.stubEnv('POS_LOGIN_SOURCE_MODE','apache-rightmost');m.rpc.mockResolvedValue({data:false,error:null})
    await expect(limitOfflineRecovery(new Request('https://pos.internext.info/api/pos/offline/import',{headers:{'x-forwarded-for':'spoofed, 203.0.113.10'}}))).rejects.toMatchObject({status:429})
    expect(m.rpc.mock.calls[0][1].p_source).toMatch(/^[a-f0-9]{64}$/)
    m.rpc.mockClear()
    await expect(limitOfflineRecovery(new Request('https://pos.internext.info/api/pos/offline/import'))).rejects.toMatchObject({status:503})
    expect(m.rpc).not.toHaveBeenCalled()
  })
})

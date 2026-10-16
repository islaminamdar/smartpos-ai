// Actual disposable PostgreSQL engine + actual P256 signatures + production service functions.
// Only the external cookie identity and Supabase transport are replaced. No network or live DB.
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
const m=vi.hoisted(()=>({rpc:vi.fn(),auth:vi.fn()}))
vi.mock('@/lib/pos/server/client',async original=>({...await original<typeof import('@/lib/pos/server/client')>(),authenticatedPosClient:m.auth,posClient:()=>({rpc:m.rpc})}))
import { OfflineEnrollmentProofExpired, enrollOfflineDevice, reserveOfflineAuthority, importOfflineReceipt, sealOfflineAuthority } from '@/lib/pos/offline/server'
import { encodeBase64Url, decodeBase64Url, parseCanonicalPayload, sha256Hex, canonicalBytes } from '@/lib/pos/offline/canonical'
import { publicKeyFingerprint, signEnvelope, verifyOfflineBundle, verifySignedEnvelope } from '@/lib/pos/offline/authority'
import { recoverOfflineBundle, nativeOfflineRecoveredSchema } from '@/lib/pos/offline/bundle-recovery'
import { offlineAckSchema } from '@/lib/pos/offline/server-contracts'
import type { OfflineIssuance } from '@/lib/pos/offline/contracts'

interface TestDb { exec(sql:string):Promise<unknown>; query(sql:string,args?:unknown[]):Promise<{rows:Record<string,unknown>[]}>; close():Promise<void> }
let db:TestDb
const ids=Object.fromEntries(['actor','org','branch','device','device2','shift','shift2','profile','product'].map(key=>[key,randomUUID()]))
const scalar=async(sql:string,args:unknown[]=[])=>Object.values((await db.query(sql,args)).rows[0])[0]
const admin=async(fn:()=>Promise<unknown>)=>{await db.exec('reset role');try{return await fn()}finally{await db.exec('set role service_role')}}
beforeAll(async()=>{
  const entry=process.env.OFFLINE_TEST_PGLITE_ENTRY
  if(!entry)throw new Error('Set OFFLINE_TEST_PGLITE_ENTRY to an installed PGlite entry. This test never connects to production.')
  const {PGlite}=await import(/* @vite-ignore */pathToFileURL(entry).href)
  db=new PGlite()
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('app.user_id',true),'')::uuid$$;
    grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`)
  for(const name of (await readdir('supabase/migrations')).filter(name=>/^20261016/.test(name)&&!name.includes('007')&&!name.includes('009')).sort())
    await db.exec(await readFile('supabase/migrations/'+name,'utf8'))
  const {actor,org,branch,device,device2,shift,shift2,profile,product}=ids
  await db.exec(`insert into auth.users values('${actor}','synthetic@example.test',now());
    insert into public.pos_organizations(id,legal_name) values('${org}','Synthetic offline integration');
    insert into public.pos_branches(id,organization_id,name) values('${branch}','${org}','Synthetic branch');
    insert into public.pos_staff(organization_id,user_id,role) values('${org}','${actor}','owner');
    insert into public.pos_devices(id,organization_id,branch_id,name) values('${device}','${org}','${branch}','Synthetic 1'),('${device2}','${org}','${branch}','Synthetic 2');
    insert into public.pos_shifts(id,organization_id,branch_id,device_id,opened_by,opening_cash_fils) values('${shift}','${org}','${branch}','${device}','${actor}',0),('${shift2}','${org}','${branch}','${device2}','${actor}',0);
    insert into public.pos_merchant_profiles(id,organization_id,branch_id,legal_name,branch_name,address,phone,trn,tax_registered,tax_inclusive,confirmed_by) values('${profile}','${org}','${branch}','Synthetic merchant','Synthetic branch','Synthetic address','Synthetic phone','100000000000001',true,true,'${actor}');
    insert into public.pos_branch_receipt_config values('${branch}','${org}','${profile}','TEST',true);
    insert into public.pos_products(id,organization_id,branch_id,name,category,unit_price_fils,tax_rate_bps) values('${product}','${org}','${branch}','Synthetic product','Synthetic',1000,500);
    insert into public.pos_offline_branch_policy(branch_id,enabled) values('${branch}',true);set role service_role;`)
  m.auth.mockResolvedValue({user:{id:actor}})
  m.rpc.mockImplementation(async(name:string,args:Record<string,unknown>)=>{
    if(!/^pos_offline_[a-z_]+$/.test(name)||Object.keys(args).some(key=>!/^p_[a-z_]+$/.test(key)))throw new Error('Unsafe test RPC name')
    try {
      const params=Object.entries(args)
      return {data:await scalar(`select public.${name}(${params.map(([key],i)=>`${key} => $${i+1}`).join(',')})`,params.map(([,value])=>value!==null&&typeof value==='object'?JSON.stringify(value):value)),error:null}
    } catch(error) {return {data:null,error:{message:(error as Error).message,code:(error as Error & {code?:string}).code}}}
  })
  vi.stubEnv('POS_ONLINE_PILOT','true');vi.stubEnv('POS_LIVE_SALES_ENABLED','true');vi.stubEnv('POS_OFFLINE_ISSUANCE_ENABLED','true')
})
afterAll(async()=>{await db?.close();vi.unstubAllEnvs()})

async function enrollmentFixture(ageMs=0) {
  const server=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify'])
  vi.stubEnv('POS_OFFLINE_SIGNING_KEY_ID','synthetic-server')
  vi.stubEnv('POS_OFFLINE_SERVER_KEYS',JSON.stringify([{id:'synthetic-server',publicKeySpki:encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki',server.publicKey))),privateKeyPkcs8:encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8',server.privateKey)))}]))
  const deviceId=randomUUID(),requestId=randomUUID(),pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify'])
  await admin(()=>db.query('insert into public.pos_devices(id,organization_id,branch_id,name) values($1,$2,$3,$4)',[deviceId,ids.org,ids.branch,'Synthetic enrollment expiry']))
  const fingerprint=await publicKeyFingerprint(pair.publicKey),publicKeySpki=encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki',pair.publicKey)))
  const serverNow=Number(await scalar('select extract(epoch from clock_timestamp())*1000'))
  const payload={kind:'offline-enrollment',schemaVersion:1,requestId,branchId:ids.branch,deviceId,actorId:ids.actor,deviceKeySha256:fingerprint,issuedAt:new Date(serverNow-ageMs).toISOString()}
  const request={requestId,branchId:ids.branch,deviceId,deviceKeySha256:fingerprint,publicKeySpki,proof:await signEnvelope(payload,fingerprint,pair.privateKey)}
  return {pair,fingerprint,payload,request}
}

it('maps the actual SQL P0001 pre-insert expiry and safely refreshes the same request ID',async()=>{
  const f=await enrollmentFixture(600_000)
  const failure=await enrollOfflineDevice(f.request).catch(error=>error)
  expect(failure).toBeInstanceOf(OfflineEnrollmentProofExpired)
  expect(failure).toMatchObject({status:409,code:'offline_enrollment_proof_expired',requestId:f.request.requestId,requestSha256:await sha256Hex(canonicalBytes(f.request))})
  const raw=await m.rpc.mock.results.at(-1)!.value
  expect(raw).toEqual({data:null,error:{code:'P0001',message:'POS_OFFLINE_PROOF_EXPIRED'}})
  expect(await admin(()=>scalar('select count(*)::int from public.pos_offline_key_epochs where request_id=$1 or device_id=$2',[f.request.requestId,f.request.deviceId]))).toBe(0)
  const refreshed={...f.request,proof:await signEnvelope({...f.payload,issuedAt:new Date().toISOString()},f.fingerprint,f.pair.privateKey)}
  const accepted=await enrollOfflineDevice(refreshed)
  expect(await enrollOfflineDevice(refreshed)).toEqual(accepted)
  expect(await admin(()=>scalar('select count(*)::int from public.pos_offline_key_epochs where request_id=$1 and device_id=$2',[f.request.requestId,f.request.deviceId]))).toBe(1)
  // Once committed, changing the decoded proof payload is forbidden, including back to
  // the original expired issuedAt. It is a conflict, never another refresh authorization.
  const conflict=await enrollOfflineDevice(f.request).catch(error=>error)
  expect(conflict).not.toBeInstanceOf(OfflineEnrollmentProofExpired)
  expect(conflict).toMatchObject({status:409,code:'pos_idempotency_conflict'})
  expect(await enrollOfflineDevice(refreshed)).toEqual(accepted)
})

it('recovers the original committed enrollment after natural proof expiry without rewriting it',async()=>{
  // Five seconds of headroom avoids a race during initial crypto/SQL processing, while
  // keeping actual wall-clock expiry verification bounded and independent of clock mocks.
  const f=await enrollmentFixture(295_000),accepted=await enrollOfflineDevice(f.request)
  const end=Date.parse(f.payload.issuedAt)+300_050
  while(Date.now()<end)await new Promise(resolve=>setTimeout(resolve,Math.min(250,end-Date.now())))
  expect(Number(await scalar('select extract(epoch from clock_timestamp())*1000'))-Date.parse(f.payload.issuedAt)).toBeGreaterThan(300_000)
  expect(await enrollOfflineDevice(f.request)).toEqual(accepted)
  const resigned={...f.request,proof:await signEnvelope(f.payload,f.fingerprint,f.pair.privateKey)}
  expect(await enrollOfflineDevice(resigned)).toEqual(accepted)
  const changed={...f.request,proof:await signEnvelope({...f.payload,issuedAt:new Date().toISOString()},f.fingerprint,f.pair.privateKey)}
  const conflict=await enrollOfflineDevice(changed).catch(error=>error)
  expect(conflict).not.toBeInstanceOf(OfflineEnrollmentProofExpired)
  expect(conflict).toMatchObject({code:'pos_idempotency_conflict'})
  expect(await enrollOfflineDevice(f.request)).toEqual(accepted)
  const stored=await admin(()=>scalar('select request_payload from public.pos_offline_key_epochs where request_id=$1',[f.request.requestId]))
  expect(stored).toEqual(f.request)
})

it('enrolls two real device keys, reserves disjoint numbers, recovers out-of-order historical bills and exact ACKs, then seals',async()=>{
  const server=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify'])
  vi.stubEnv('POS_OFFLINE_SIGNING_KEY_ID','synthetic-server')
  vi.stubEnv('POS_OFFLINE_SERVER_KEYS',JSON.stringify([{id:'synthetic-server',publicKeySpki:encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki',server.publicKey))),privateKeyPkcs8:encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('pkcs8',server.privateKey)))}]))
  const devices=[]
  for(const [deviceId,shiftId] of [[ids.device,ids.shift],[ids.device2,ids.shift2]]) {
    const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),fingerprint=await publicKeyFingerprint(pair.publicKey)
    const requestId=randomUUID(),publicKeySpki=encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki',pair.publicKey)))
    const proof=await signEnvelope({kind:'offline-enrollment',schemaVersion:1,requestId,branchId:ids.branch,deviceId,actorId:ids.actor,deviceKeySha256:fingerprint,issuedAt:new Date().toISOString()},fingerprint,pair.privateKey)
    const request={requestId,branchId:ids.branch,deviceId,deviceKeySha256:fingerprint,publicKeySpki,proof}
    const enrolled=await enrollOfflineDevice(request)
    expect(await enrollOfflineDevice(request)).toEqual(enrolled)
    const reservation={requestId:randomUUID(),branchId:ids.branch,deviceId,shiftId,count:3,lifetimeSeconds:3600,maxInvoiceTotalFils:100000,maxGrossFils:300000,permissions:{cash:true,recordedCard:true,mixedTender:true}}
    const signed=await reserveOfflineAuthority(reservation)
    expect(await reserveOfflineAuthority(reservation)).toEqual(signed)
    const bundle=await verifyOfflineBundle(signed.snapshotEnvelope,signed.authorityEnvelope,{'synthetic-server':server.publicKey})
    devices.push({pair,fingerprint,bundle,enrolled})
  }
  expect(devices[0].bundle.authority.invoiceRange).toEqual({prefix:'TEST',first:1,last:3})
  expect(devices[1].bundle.authority.invoiceRange).toEqual({prefix:'TEST',first:4,last:6})
  expect(await admin(()=>scalar('select public.pos_allocate_document_number($1,$2)',[ids.branch,'tax_invoice']))).toBe('TEST-INV-0000000007')
  await expect(admin(()=>db.exec(`update public.pos_shifts set status='closed',closed_at=now() where id='${ids.shift}'`))).rejects.toThrow('POS_OFFLINE_CHAIN_INCOMPLETE')
  const firstDevice=devices[0],a=firstDevice.bundle.authority
  function sale(sequence:number,previous:string|null,number:number):OfflineIssuance {
    const id=randomUUID(),issuedAt=a.issuedAt
    return {kind:'offline-sale',schemaVersion:1,id,authorityId:a.id,authoritySha256:firstDevice.bundle.authoritySha256,snapshotSha256:firstDevice.bundle.snapshotSha256,deviceSequence:sequence,previousEventSha256:previous,paymentIntentId:randomUUID(),clock:{estimatedServerAt:issuedAt,bootId:randomUUID(),elapsedRealtimeMs:1234},
      document:{schemaVersion:1,id:randomUUID(),kind:'tax_invoice',documentNumber:'TEST-INV-'+String(number).padStart(10,'0'),issuedAt,merchant:firstDevice.bundle.snapshot.profile,orderId:id,branchId:a.branchId,deviceId:a.deviceId,shiftId:a.shiftId,actorId:a.actorId,serviceType:'takeaway',customer:null,
        lines:[{lineNumber:1,productId:ids.product,name:'Synthetic product',unit:'piece',quantityMilli:1000,unitPriceFils:1000,taxRateBps:500,grossFils:1000,netFils:952,taxFils:48}],totals:{grossFils:1000,netFils:952,taxFils:48},payments:[{method:'cash',amountFils:1000}],paymentSettlement:'recorded',cashTenderedFils:1500,changeFils:500}}
  }
  const first=sale(1,null,1),firstHash=await sha256Hex(canonicalBytes(first)),second=sale(2,firstHash,2)
  const signedFirst=await signEnvelope(first,firstDevice.fingerprint,firstDevice.pair.privateKey),signedSecond=await signEnvelope(second,firstDevice.fingerprint,firstDevice.pair.privateKey)
  // Reserve a third device's authority, then simulate process death before signing/attach.
  // It must be recoverable using historical possession alone after current access is revoked.
  const pendingDevice=randomUUID(),pendingShift=randomUUID(),pendingId=randomUUID()
  await admin(()=>db.exec(`insert into public.pos_devices(id,organization_id,branch_id,name) values('${pendingDevice}','${ids.org}','${ids.branch}','Synthetic interrupted attachment');insert into public.pos_shifts(id,organization_id,branch_id,device_id,opened_by,opening_cash_fils) values('${pendingShift}','${ids.org}','${ids.branch}','${pendingDevice}','${ids.actor}',0);`))
  const pendingKey=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),pendingFingerprint=await publicKeyFingerprint(pendingKey.publicKey),enrollmentId=randomUUID()
  const pendingEpoch=await enrollOfflineDevice({requestId:enrollmentId,branchId:ids.branch,deviceId:pendingDevice,deviceKeySha256:pendingFingerprint,publicKeySpki:encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki',pendingKey.publicKey))),proof:await signEnvelope({kind:'offline-enrollment',schemaVersion:1,requestId:enrollmentId,branchId:ids.branch,deviceId:pendingDevice,actorId:ids.actor,deviceKeySha256:pendingFingerprint,issuedAt:new Date().toISOString()},pendingFingerprint,pendingKey.privateKey)})
  const pendingReservation={requestId:pendingId,branchId:ids.branch,deviceId:pendingDevice,shiftId:pendingShift,count:2,lifetimeSeconds:60,maxInvoiceTotalFils:100000,maxGrossFils:200000,permissions:{cash:true,recordedCard:false,mixedTender:false}}
  const reserved=await m.rpc('pos_offline_reserve',{p_actor:ids.actor,p_request:pendingReservation});expect(reserved.error).toBeNull()
  const counterBeforeRecovery=await admin(()=>scalar("select last_number from public.pos_document_counters where branch_id=$1 and kind='tax_invoice'",[ids.branch]))
  const originalAttached=await scalar('select public.pos_offline_authority($1)',[a.id]) as Record<string,unknown>
  await admin(()=>db.exec(`update public.pos_products set unit_price_fils=2500,active=false,revision=2 where id='${ids.product}';update public.pos_staff set active=false where user_id='${ids.actor}';update public.pos_devices set active=false where id='${ids.device}';update public.pos_offline_branch_policy set enabled=false;`))
  vi.stubEnv('POS_ONLINE_PILOT','false');vi.stubEnv('POS_LIVE_SALES_ENABLED','false');vi.stubEnv('POS_OFFLINE_ISSUANCE_ENABLED','false');m.auth.mockRejectedValue(new Error('revoked'))
  await admin(()=>db.query('update public.pos_devices set active=false where id=$1',[pendingDevice]))
  const historicalProof={kind:'offline-bundle-recovery',schemaVersion:1,authorityId:a.id,keyEpoch:a.keyEpoch,deviceId:a.deviceId,challenge:'a'.repeat(64)}
  const recoveredOriginal=await recoverOfflineBundle(await signEnvelope(historicalProof,firstDevice.fingerprint,firstDevice.pair.privateKey))
  expect(recoveredOriginal.snapshotEnvelope).toEqual(originalAttached.snapshotEnvelope);expect(recoveredOriginal.authorityEnvelope).toEqual(originalAttached.authorityEnvelope)
  const pendingProof={...historicalProof,authorityId:pendingId,keyEpoch:pendingEpoch.keyEpoch,deviceId:pendingDevice}
  await expect(recoverOfflineBundle(await signEnvelope(pendingProof,pendingFingerprint,firstDevice.pair.privateKey))).rejects.toMatchObject({code:'offline_device_proof_invalid'})
  await expect(recoverOfflineBundle(await signEnvelope({...pendingProof,keyEpoch:a.keyEpoch},pendingFingerprint,pendingKey.privateKey))).rejects.toMatchObject({code:'offline_device_proof_invalid'})
  expect(await admin(()=>scalar('select count(*)::int from public.pos_offline_signed_bundles where authority_id=$1',[pendingId]))).toBe(0)
  const recovered=await recoverOfflineBundle(await signEnvelope(pendingProof,pendingFingerprint,pendingKey.privateKey))
  const recoveredBundle=await verifyOfflineBundle(recovered.snapshotEnvelope,recovered.authorityEnvelope,{'synthetic-server':server.publicKey})
  expect(recoveredBundle.snapshot).toEqual(reserved.data.snapshot)
  expect(recoveredBundle.authority).toEqual({...reserved.data.authority,snapshotSha256:recoveredBundle.snapshotSha256})
  expect(recoveredBundle.authority.expiresAt).toBe(reserved.data.authority.expiresAt)
  const handoff=(await verifySignedEnvelope(recovered.handoff,nativeOfflineRecoveredSchema,{'synthetic-server':server.publicKey})).payload
  expect(handoff).toMatchObject({purpose:'reconciliation-only',kind:'native-offline-recovered',challenge:pendingProof.challenge,authorityId:pendingId,keyEpoch:pendingEpoch.keyEpoch,deviceId:pendingDevice,snapshotSha256:recoveredBundle.snapshotSha256,authoritySha256:recoveredBundle.authoritySha256})
  const recoveredRetry=await recoverOfflineBundle(await signEnvelope({...pendingProof,challenge:'b'.repeat(64)},pendingFingerprint,pendingKey.privateKey))
  expect(recoveredRetry.snapshotEnvelope).toEqual(recovered.snapshotEnvelope);expect(recoveredRetry.authorityEnvelope).toEqual(recovered.authorityEnvelope)
  expect(await admin(()=>scalar('select count(*)::int from public.pos_offline_signed_bundles where authority_id=$1',[pendingId]))).toBe(1)
  expect(await admin(()=>scalar("select last_number from public.pos_document_counters where branch_id=$1 and kind='tax_invoice'",[ids.branch]))).toBe(counterBeforeRecovery)
  expect(await admin(()=>scalar('select count(*)::int from public.pos_offline_authorities where id=$1',[pendingId]))).toBe(1)
  const gap=await importOfflineReceipt(signedSecond);expect(gap).toMatchObject({status:'reconciliation_required',code:'chain'})
  const accepted=await importOfflineReceipt(signedFirst),acceptedSecond=await importOfflineReceipt(signedSecond)
  expect(accepted).toMatchObject({status:'accepted',replayed:false,receipt:first.document});expect(acceptedSecond).toMatchObject({status:'accepted',replayed:false})
  const retry=await importOfflineReceipt(await signEnvelope(first,firstDevice.fingerprint,firstDevice.pair.privateKey))
  expect(retry).toMatchObject({status:'accepted',replayed:true})
  if(accepted.status!=='accepted'||retry.status!=='accepted')throw new Error('Missing committed ACK')
  expect(retry.acknowledgement).toEqual(accepted.acknowledgement)
  expect((await verifySignedEnvelope(accepted.acknowledgement,offlineAckSchema,{'synthetic-server':server.publicKey})).payload.payloadSha256).toBe(firstHash)
  expect(await admin(()=>scalar('select count(*)::int from public.pos_documents'))).toBe(2)
  expect(await admin(()=>scalar('select count(*)::int from public.pos_kitchen_tickets'))).toBe(0)
  expect(await admin(()=>scalar('select sum(total_fils)::int from public.pos_orders'))).toBe(2000)
  const seal={kind:'offline-seal',schemaVersion:1,id:randomUUID(),authorityId:a.id,keyEpoch:a.keyEpoch,deviceId:a.deviceId,finalSequence:2,finalEventSha256:await sha256Hex(canonicalBytes(second))}
  expect(await sealOfflineAuthority(await signEnvelope(seal,firstDevice.fingerprint,firstDevice.pair.privateKey))).toMatchObject({status:'sealed',finalSequence:2})
  await admin(()=>db.exec(`update public.pos_shifts set status='closed',closed_at=now() where id='${ids.shift}'`))
  expect(await admin(()=>scalar('select status from public.pos_shifts where id=$1',[ids.shift]))).toBe('closed')
  // A fresh, correctly signed but forged price remains durable evidence, not an extra paid invoice.
  const forged=sale(3,seal.finalEventSha256,3);forged.document.lines[0].name='Changed name'
  expect(await importOfflineReceipt(await signEnvelope(forged,firstDevice.fingerprint,firstDevice.pair.privateKey))).toMatchObject({status:'reconciliation_required',code:'invalid_historical_receipt'})
  expect(await admin(()=>scalar('select count(*)::int from public.pos_documents'))).toBe(2)
  expect(parseCanonicalPayload(decodeBase64Url(retry.acknowledgement.payloadBase64Url))).toMatchObject({issuanceId:first.id})
})

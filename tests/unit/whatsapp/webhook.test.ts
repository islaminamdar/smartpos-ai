import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks=vi.hoisted(()=>({createServiceRole:vi.fn(),handleInbound:vi.fn()}))
vi.mock('@/lib/db/supabase',()=>({createServiceRole:mocks.createServiceRole}))
vi.mock('@/lib/whatsapp/handler',()=>({handleInbound:mocks.handleInbound}))
import { GET, POST } from '@/app/api/whatsapp/webhook/route'
const post=(body:string,signature?:string)=>new Request('http://localhost/api/whatsapp/webhook',{method:'POST',body,headers:signature?{'x-hub-signature-256':signature}:{}})
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('ENABLE_LEGACY_WHATSAPP_WEBHOOK','');vi.stubEnv('META_APP_SECRET','test-secret');vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN','test-token')})
afterEach(()=>vi.unstubAllEnvs())
describe('legacy WhatsApp release gate',()=>{
 it('rejects both disabled methods before any database or outbound effect',async()=>{
  expect((await GET(new Request('http://localhost/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=test-token'))).status).toBe(404)
  expect((await POST(post('{"entry":[]}'))).status).toBe(404)
  expect(mocks.createServiceRole).not.toHaveBeenCalled();expect(mocks.handleInbound).not.toHaveBeenCalled()
 })
 it('fails closed for missing configuration or unsigned/invalid payloads when explicitly enabled',async()=>{
  vi.stubEnv('ENABLE_LEGACY_WHATSAPP_WEBHOOK','true')
  expect((await POST(post('{}'))).status).toBe(403)
  expect((await POST(post('{}','sha256='+'0'.repeat(64)))).status).toBe(403)
  vi.stubEnv('META_APP_SECRET','')
  expect((await POST(post('{}'))).status).toBe(503)
  expect(mocks.createServiceRole).not.toHaveBeenCalled();expect(mocks.handleInbound).not.toHaveBeenCalled()
 })
 it('verifies an exact raw-body signature before accepting a harmless delivery status event',async()=>{
  vi.stubEnv('ENABLE_LEGACY_WHATSAPP_WEBHOOK','true')
  const body=JSON.stringify({entry:[]})
  const signature='sha256='+createHmac('sha256','test-secret').update(body).digest('hex')
  expect((await POST(post(body,signature))).status).toBe(200)
  expect((await POST(post(body+' ',signature))).status).toBe(403)
  expect(mocks.createServiceRole).not.toHaveBeenCalled();expect(mocks.handleInbound).not.toHaveBeenCalled()
 })
})

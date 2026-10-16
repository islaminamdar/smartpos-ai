// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
const m=vi.hoisted(()=>({enroll:vi.fn(),reserve:vi.fn(),importReceipt:vi.fn(),seal:vi.fn(),limit:vi.fn()}))
vi.mock('@/lib/pos/offline/server',()=>({enrollOfflineDevice:m.enroll,reserveOfflineAuthority:m.reserve,importOfflineReceipt:m.importReceipt,sealOfflineAuthority:m.seal,limitOfflineRecovery:m.limit}))
import { POST as enroll } from '@/app/api/pos/offline/enroll/route'
import { POST as reserve } from '@/app/api/pos/offline/authority/route'
import { POST as upload } from '@/app/api/pos/offline/import/route'
import { POST as seal } from '@/app/api/pos/offline/seal/route'
import { PosServerError } from '@/lib/pos/server/client'
const origin='https://pos.internext.info'
const request=(path:string,body:string,headers:Record<string,string>={})=>new Request(origin+'/api/pos/offline/'+path,{method:'POST',body,headers:{'Content-Type':'application/json',...headers}})
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('POS_PUBLIC_ORIGIN',origin);m.limit.mockResolvedValue(undefined)})
afterEach(()=>vi.unstubAllEnvs())

it('requires same-origin manager mutations before invoking enrollment/reservation',async()=>{
  for(const [path,handler] of [['enroll',enroll],['authority',reserve]] as const){
    expect((await handler(request(path,'{}'))).status).toBe(403)
    expect((await handler(request(path,'{}',{Origin:'https://untrusted.example'}))).status).toBe(403)
  }
  expect(m.enroll).not.toHaveBeenCalled();expect(m.reserve).not.toHaveBeenCalled()
})
it('bounds streamed bodies without trusting Content-Length on all four operations',async()=>{
  for(const [path,handler,limit] of [['enroll',enroll,16384],['authority',reserve,4096],['import',upload,1400000],['seal',seal,16384]] as const){
    const response=await handler(request(path,'a'.repeat(limit+1),{Origin:origin}))
    expect(response.status).toBe(413);expect(response.headers.get('cache-control')).toBe('private, no-store')
  }
  expect(m.enroll).not.toHaveBeenCalled();expect(m.reserve).not.toHaveBeenCalled();expect(m.importReceipt).not.toHaveBeenCalled();expect(m.seal).not.toHaveBeenCalled()
})
it('permits native signed upload without browser Origin and returns durable reconciliation as409',async()=>{
  m.importReceipt.mockResolvedValue({status:'reconciliation_required',exceptionId:'synthetic',code:'chain'})
  const response=await upload(request('import','{"signed":"evidence"}'))
  expect(response.status).toBe(409);expect(await response.json()).toMatchObject({code:'chain'})
  expect(m.limit).toHaveBeenCalledTimes(1);expect(m.importReceipt).toHaveBeenCalledWith({signed:'evidence'})
})
it('applies source throttling before parsing or processing recovery payloads',async()=>{
  m.limit.mockRejectedValue(new PosServerError('offline_upload_rate_limited',429))
  expect((await upload(request('import','not json'))).status).toBe(429)
  expect((await seal(request('seal','not json'))).status).toBe(429)
  expect(m.importReceipt).not.toHaveBeenCalled();expect(m.seal).not.toHaveBeenCalled()
})
it('distinguishes malformed JSON/schema and never exposes internal errors',async()=>{
  expect((await reserve(request('authority','not json',{Origin:origin}))).status).toBe(400)
  m.reserve.mockImplementation(()=>z.object({id:z.string().uuid()}).parse({id:'bad'}))
  expect((await reserve(request('authority','{}',{Origin:origin}))).status).toBe(422)
  m.seal.mockRejectedValue(new Error('private signing material must not leak'))
  const response=await seal(request('seal','{}'));expect(response.status).toBe(503)
  expect(await response.text()).not.toContain('private signing material')
})

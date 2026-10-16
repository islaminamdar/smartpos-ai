// @vitest-environment node
import { beforeAll, afterAll, it, expect } from 'vitest'
import { chromium, type Browser, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import ts from 'typescript'

let browser: Browser, page: Page, server: Server
beforeAll(async () => {
  const source = ts.transpileModule(readFileSync('lib/pos/online-journal.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ES2020 },
  }).outputText
  server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/journal.js' ? 'text/javascript' : 'text/html')
    res.end(
      req.url === '/journal.js' ? source : '<!doctype html><title>Isolated journal test</title>'
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  browser = await chromium.launch({
    headless: true,
    executablePath: existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined,
    args: ['--no-sandbox'],
  })
  page = await browser.newPage()
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server unavailable')
  await page.goto(`http://127.0.0.1:${address.port}`)
})
afterAll(async () => {
  await browser?.close()
  await new Promise<void>((resolve) => server?.close(() => resolve()))
})

it('retains one immutable request across competing tabs, reload and mismatched acknowledgements', async () => {
  const first = await page.evaluate(async () => {
    const mod = await new Function('return import("/journal.js")')()
    const base = {
      actorId: 'actor-a',
      deviceId: 'device',
      branchId: 'branch',
      endpoint: '/api/pos/sync',
      body: { total: 600 },
      savedAt: new Date().toISOString(),
    }
    const outcomes = await Promise.allSettled([
      mod.savePendingRequest({ ...base, id: 'first' }),
      mod.savePendingRequest({ ...base, id: 'second' }),
    ])
    return {
      successes: outcomes.filter((result) => result.status === 'fulfilled').length,
      record: await mod.readPendingRequest('actor-a'),
      otherActor: await mod.readPendingRequest('actor-b'),
    }
  })
  expect(first.successes).toBe(1)
  expect(first.otherActor).toBeNull()
  await page.reload()
  const second = await page.evaluate(async () => {
    const mod = await new Function('return import("/journal.js")')()
    const record = await mod.readPendingRequest('actor-a')
    let rejected = false
    try {
      await mod.acknowledgePendingRequest('actor-a', 'different')
    } catch {
      rejected = true
    }
    const retained = await mod.readPendingRequest('actor-a')
    await mod.acknowledgePendingRequest('actor-a', record.id)
    return { record, rejected, retained, after: await mod.readPendingRequest('actor-a') }
  })
  expect(second.record).toEqual(first.record)
  expect(second.rejected).toBe(true)
  expect(second.retained).toEqual(first.record)
  expect(second.after).toBeNull()
})

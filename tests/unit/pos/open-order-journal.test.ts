// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
let browser: Browser, server: Server, page: Page, other: Page
const actor = '30000000-0000-4000-8000-000000000001'
const command = {
  id: '80000000-0000-4000-8000-000000000001',
  branchId: '10000000-0000-4000-8000-000000000001',
  deviceId: '20000000-0000-4000-8000-000000000001',
  type: 'tab.save',
  tabId: '40000000-0000-4000-8000-000000000001',
  expectedRevision: 0,
  label: 'Storage verification',
  serviceType: 'takeaway',
  tableId: null,
  guestCount: null,
  note: '',
  lines: [],
}

beforeAll(async () => {
  const transpile = (path: string) =>
    ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText
  const code = transpile('lib/pos/open-order-journal.ts').replace(
    "'./server/open-order-contracts'",
    "'/open-order.js'"
  )
  const schema = transpile('lib/pos/server/open-order-contracts.ts')
    .replace("'zod'", "'/zod/index.js'")
    .replace("'./contracts'", "'/contracts.js'")
  const contracts = transpile('lib/pos/server/contracts.ts').replace("'zod'", "'/zod/index.js'")
  server = createServer((request, response) => {
    const url = request.url ?? '/'
    response.setHeader('Content-Type', url.endsWith('.js') ? 'application/javascript' : 'text/html')
    if (url === '/journal.js') response.end(code)
    else if (url === '/open-order.js') response.end(schema)
    else if (url === '/contracts.js') response.end(contracts)
    else if (/^\/zod\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.js$/.test(url))
      response.end(readFileSync(join(process.cwd(), 'node_modules', url)))
    else response.end('<!doctype html><title>OpenOrder journal verification</title>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server')
  browser = await chromium.launch({
    headless: true,
    executablePath: existsSync(chromium.executablePath()) ? undefined : '/usr/bin/google-chrome',
  })
  const context = await browser.newContext()
  page = await context.newPage()
  other = await context.newPage()
  await Promise.all([
    page.goto(`http://127.0.0.1:${address.port}`),
    other.goto(`http://127.0.0.1:${address.port}`),
  ])
}, 30000)
afterAll(async () => {
  await browser?.close()
  await new Promise<void>((resolve) => server?.close(() => resolve()))
})
it('atomic same-actor branch writes from two real tabs retain exactly one request', async () => {
  const run = (p: Page, id: string) =>
    p.evaluate(
      async ({ actor, command, id }) => {
        const journal = await new Function('return import("/journal.js")')()
        try {
          await journal.savePendingOpenOrderRequest({ actorId: actor, command: { ...command, id } })
          return 'saved'
        } catch {
          return 'blocked'
        }
      },
      { actor, command, id }
    )
  const results = await Promise.all([
    run(page, command.id),
    run(other, '80000000-0000-4000-8000-000000000002'),
  ])
  expect(results.sort()).toEqual(['blocked', 'saved'])
  const records = await page.evaluate(
    async (actor) =>
      (await new Function('return import("/journal.js")')()).readPendingOpenOrderRequests(actor),
    actor
  )
  expect(records).toHaveLength(1)
  expect(records[0].command.deviceId).toBe(command.deviceId)
})
it('reload preserves original command, foreign actor cannot read it, mismatched ACK cannot delete it', async () => {
  await page.reload()
  const result = await page.evaluate(async (actor) => {
    const journal = await new Function('return import("/journal.js")')()
    const before = await journal.readPendingOpenOrderRequests(actor)
    const foreign = await journal.readPendingOpenOrderRequests(
      '90000000-0000-4000-8000-000000000001'
    )
    let rejected = false
    try {
      await journal.acknowledgeOpenOrderRequest(
        actor,
        before[0].command.branchId,
        '80000000-0000-4000-8000-000000000099'
      )
    } catch {
      rejected = true
    }
    return { before, foreign, rejected, after: await journal.readPendingOpenOrderRequests(actor) }
  }, actor)
  expect(result.rejected).toBe(true)
  expect(result.foreign).toEqual([])
  expect(result.before).toEqual(result.after)
})
it('notification failure cannot invalidate committed storage or exact acknowledgement', async () => {
  const result = await page.evaluate(async (actor) => {
    const journal = await new Function('return import("/journal.js")')()
    const before = await journal.readPendingOpenOrderRequests(actor)
    Object.defineProperty(window, 'BroadcastChannel', {
      configurable: true,
      value: class {
        constructor() {
          throw new Error('blocked')
        }
      },
    })
    await journal.acknowledgeOpenOrderRequest(
      actor,
      before[0].command.branchId,
      before[0].command.id
    )
    await journal.savePendingOpenOrderRequest(before[0])
    const saved = await journal.readPendingOpenOrderRequests(actor)
    await journal.acknowledgeOpenOrderRequest(
      actor,
      before[0].command.branchId,
      before[0].command.id
    )
    return { saved: saved.length, after: await journal.readPendingOpenOrderRequests(actor) }
  }, actor)
  expect(result).toEqual({ saved: 1, after: [] })
})

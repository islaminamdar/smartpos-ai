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
  type: 'dispatch',
  tabId: '40000000-0000-4000-8000-000000000001',
  expectedTabRevision: 1,
  expectedTicketRevision: 0,
  reason: null,
}

beforeAll(async () => {
  const transpile = (path: string) =>
    ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText
  const code = transpile('lib/pos/tab-kitchen-journal.ts').replace(
    "'./server/tab-kitchen'",
    "'/tab-kitchen.js'"
  )
  const schema = transpile('lib/pos/server/tab-kitchen.ts')
    .replace("'zod'", "'/zod/index.js'")
    .replace("'./contracts'", "'/contracts.js'")
  const contracts = transpile('lib/pos/server/contracts.ts').replace("'zod'", "'/zod/index.js'")
  server = createServer((request, response) => {
    const url = request.url ?? '/'
    response.setHeader('Content-Type', url.endsWith('.js') ? 'application/javascript' : 'text/html')
    if (url === '/journal.js') response.end(code)
    else if (url === '/tab-kitchen.js') response.end(schema)
    else if (url === '/contracts.js') response.end(contracts)
    else if (/^\/zod\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.js$/.test(url))
      response.end(readFileSync(join(process.cwd(), 'node_modules', url)))
    else response.end('<!doctype html><title>TabKitchen journal verification</title>')
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
          await journal.savePendingTabKitchenRequest({
            actorId: actor,
            command: { ...command, id },
          })
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
      (await new Function('return import("/journal.js")')()).readPendingTabKitchenRequests(actor),
    actor
  )
  expect(records).toHaveLength(1)
  expect(records[0].command.deviceId).toBe(command.deviceId)
})
it('reload preserves original command, foreign actor cannot read it, mismatched ACK cannot delete it', async () => {
  await page.reload()
  const result = await page.evaluate(async (actor) => {
    const journal = await new Function('return import("/journal.js")')()
    const before = await journal.readPendingTabKitchenRequests(actor)
    const foreign = await journal.readPendingTabKitchenRequests(
      '90000000-0000-4000-8000-000000000001'
    )
    let rejected = false
    try {
      await journal.acknowledgeTabKitchenRequest(
        actor,
        before[0].command.branchId,
        '80000000-0000-4000-8000-000000000099'
      )
    } catch {
      rejected = true
    }
    return { before, foreign, rejected, after: await journal.readPendingTabKitchenRequests(actor) }
  }, actor)
  expect(result.rejected).toBe(true)
  expect(result.foreign).toEqual([])
  expect(result.before).toEqual(result.after)
})
it('notification failure cannot invalidate committed storage or exact acknowledgement', async () => {
  const result = await page.evaluate(async (actor) => {
    const journal = await new Function('return import("/journal.js")')()
    const before = await journal.readPendingTabKitchenRequests(actor)
    Object.defineProperty(window, 'BroadcastChannel', {
      configurable: true,
      value: class {
        constructor() {
          throw new Error('blocked')
        }
      },
    })
    await journal.acknowledgeTabKitchenRequest(
      actor,
      before[0].command.branchId,
      before[0].command.id
    )
    await journal.savePendingTabKitchenRequest(before[0])
    const saved = await journal.readPendingTabKitchenRequests(actor)
    await journal.acknowledgeTabKitchenRequest(
      actor,
      before[0].command.branchId,
      before[0].command.id
    )
    return { saved: saved.length, after: await journal.readPendingTabKitchenRequests(actor) }
  }, actor)
  expect(result).toEqual({ saved: 1, after: [] })
})

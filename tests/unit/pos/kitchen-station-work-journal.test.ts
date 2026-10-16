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
  workId: '40000000-0000-4000-8000-000000000001',
  type: 'stage',
  expectedRevision: 1,
  from: 'queued',
  to: 'preparing',
  reason: null,
}
beforeAll(async () => {
  const transpile = (path: string) =>
    ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText
  const code = transpile('lib/pos/kitchen-station-work-journal.ts')
    .replace("'./server/kitchen-station-work'", "'/kitchen.js'")
    .replace("'zod'", "'/zod/index.js'")
  const schema = transpile('lib/pos/server/kitchen-station-work.ts').replace(
    "'zod'",
    "'/zod/index.js'"
  )
  server = createServer((request, response) => {
    const url = request.url ?? '/'
    response.setHeader('Content-Type', url.endsWith('.js') ? 'application/javascript' : 'text/html')
    if (url === '/journal.js') response.end(code)
    else if (url === '/kitchen.js') response.end(schema)
    else if (/^\/zod\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.js$/.test(url))
      response.end(readFileSync(join(process.cwd(), 'node_modules', url)))
    else response.end('<!doctype html><title>Kitchen journal verification</title>')
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
          await journal.savePendingStationWorkRequest({
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
      (await new Function('return import("/journal.js")')()).readPendingStationWorkRequests(actor),
    actor
  )
  expect(records).toHaveLength(1)
  expect(records[0].command.deviceId).toBe(command.deviceId)
})
it('reload preserves original command, foreign actor cannot read it, mismatched ACK cannot delete it', async () => {
  await page.reload()
  const result = await page.evaluate(async (actor) => {
    const journal = await new Function('return import("/journal.js")')()
    const before = await journal.readPendingStationWorkRequests(actor)
    const foreign = await journal.readPendingStationWorkRequests(
      '90000000-0000-4000-8000-000000000001'
    )
    let rejected = false
    try {
      await journal.acknowledgeStationWorkRequest(actor, before[0].command, {
        status: 'cancelled',
        workId: before[0].command.workId,
        requestId: '80000000-0000-4000-8000-000000000099',
        branchId: before[0].command.branchId,
        replayed: false,
      })
    } catch {
      rejected = true
    }
    return { before, foreign, rejected, after: await journal.readPendingStationWorkRequests(actor) }
  }, actor)
  expect(result.rejected).toBe(true)
  expect(result.foreign).toEqual([])
  expect(result.before).toEqual(result.after)
})
it('notification failure cannot invalidate committed storage or exact acknowledgement', async () => {
  const result = await page.evaluate(async (actor) => {
    const journal = await new Function('return import("/journal.js")')()
    const before = await journal.readPendingStationWorkRequests(actor)
    Object.defineProperty(window, 'BroadcastChannel', {
      configurable: true,
      value: class {
        constructor() {
          throw new Error('blocked')
        }
      },
    })
    await journal.acknowledgeStationWorkRequest(actor, before[0].command, {
      status: 'cancelled',
      workId: before[0].command.workId,
      requestId: before[0].command.id,
      branchId: before[0].command.branchId,
      replayed: false,
    })
    await journal.savePendingStationWorkRequest(before[0])
    const saved = await journal.readPendingStationWorkRequests(actor)
    await journal.acknowledgeStationWorkRequest(actor, before[0].command, {
      status: 'cancelled',
      workId: before[0].command.workId,
      requestId: before[0].command.id,
      branchId: before[0].command.branchId,
      replayed: false,
    })
    return { saved: saved.length, after: await journal.readPendingStationWorkRequests(actor) }
  }, actor)
  expect(result).toEqual({ saved: 1, after: [] })
})
it('full command comparison prevents a same-ID edited request from clearing custody', async () => {
  const result = await page.evaluate(
    async ({ actor, command }) => {
      const journal = await new Function('return import("/journal.js")')()
      await journal.savePendingStationWorkRequest({ actorId: actor, command })
      let rejected = false
      try {
        await journal.acknowledgeStationWorkRequest(
          actor,
          { ...command, reason: 'Changed' },
          {
            status: 'cancelled',
            workId: command.workId,
            requestId: command.id,
            branchId: command.branchId,
            replayed: false,
          }
        )
      } catch {
        rejected = true
      }
      return { rejected, records: await journal.readPendingStationWorkRequests(actor) }
    },
    { actor, command }
  )
  expect(result.rejected).toBe(true)
  expect(result.records[0].command).toEqual(command)
})
it('malformed stored actor scope fails closed rather than presenting no pending work', async () => {
  const result = await page.evaluate(async (actor) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('internext-pos-kitchen-station-work-journal-v1', 1)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('requests', 'readwrite')
        tx.objectStore('requests').put({ key: `${actor}:broken`, actorId: actor, command: {} })
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
    })
    try {
      await (
        await new Function('return import("/journal.js")')()
      ).readPendingStationWorkRequests(actor)
      return false
    } catch {
      return true
    }
  }, actor)
  expect(result).toBe(true)
})

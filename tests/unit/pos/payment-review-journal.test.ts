// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import ts from 'typescript'
import { reviewActor, reviewBranch, reviewId, reviewRequest } from './fixtures/payment-review-ui'
let browser: Browser, server: Server, page: Page, other: Page
beforeAll(async () => {
  const modules = new Map<string, string>()
  function compile(path: string): string {
    const absolute = resolve(path),
      url = '/src/' + absolute.slice(process.cwd().length + 1).replace(/\.ts$/, '.js')
    if (modules.has(url)) return url
    modules.set(url, '')
    let code = ts.transpileModule(readFileSync(absolute, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText
    code = code.replace(/from ['"]([^'"]+)['"]/g, (_all, specifier: string) => {
      if (specifier === 'zod') return "from '/zod/index.js'"
      const next = specifier.startsWith('@/')
        ? resolve(specifier.slice(2) + '.ts')
        : resolve(dirname(absolute), specifier + '.ts')
      return `from '${compile(next)}'`
    })
    modules.set(url, code)
    return url
  }
  const entry = compile('components/pos/offline-payments/journal.ts')
  server = createServer((req, res) => {
    const url = req.url ?? '/'
    res.setHeader('Content-Type', url.endsWith('.js') ? 'application/javascript' : 'text/html')
    if (url === '/journal.js') res.end(`export * from '${entry}'`)
    else if (modules.has(url)) res.end(modules.get(url))
    else if (/^\/zod\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.js$/.test(url))
      res.end(readFileSync(join(process.cwd(), 'node_modules', url)))
    else res.end('<!doctype html><title>Synthetic journal verification</title>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('server')
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
const record = {
  actorId: reviewActor,
  branchId: reviewBranch,
  caseId: reviewId(3),
  request: reviewRequest,
}
it('two tabs cannot overwrite exact password-free pending request; reload and actor separation retain custody', async () => {
  const save = (p: Page, requestId: string) =>
    p.evaluate(
      async ({ record, requestId }) => {
        const j = await new Function('return import("/journal.js")')()
        try {
          await j.savePendingPaymentReview({ ...record, request: { ...record.request, requestId } })
          return 'saved'
        } catch {
          return 'blocked'
        }
      },
      { record, requestId }
    )
  expect((await Promise.all([save(page, reviewId(14)), save(other, reviewId(44))])).sort()).toEqual(
    ['blocked', 'saved']
  )
  await page.reload()
  const result = await page.evaluate(async (actor) => {
    const j = await new Function('return import("/journal.js")')()
    return {
      mine: await j.readPendingPaymentReviews(actor),
      foreign: await j.readPendingPaymentReviews('10000000-0000-4000-8000-000000000099'),
    }
  }, reviewActor)
  expect(result.mine).toHaveLength(1)
  expect(result.foreign).toEqual([])
  expect(result.mine[0].request.freezeId).toBe(record.request.freezeId)
})
it('rejects password-bearing records and mismatched acknowledgement; exact delete works despite notification failure', async () => {
  const result = await page.evaluate(async (record) => {
    const j = await new Function('return import("/journal.js")')()
    const [saved] = await j.readPendingPaymentReviews(record.actorId)
    let passwordRejected = false,
      wrongAckRejected = false
    try {
      await j.savePendingPaymentReview({ ...record, currentPassword: 'synthetic-only' })
    } catch {
      passwordRejected = true
    }
    try {
      await j.acknowledgePaymentReview({
        ...saved,
        request: { ...saved.request, reason: 'Different evidence' },
      })
    } catch {
      wrongAckRejected = true
    }
    const retained = await j.readPendingPaymentReviews(record.actorId)
    Object.defineProperty(window, 'BroadcastChannel', {
      configurable: true,
      value: class {
        constructor() {
          throw Error('unavailable')
        }
      },
    })
    await j.acknowledgePaymentReview(saved)
    return {
      passwordRejected,
      wrongAckRejected,
      retained: retained.length,
      after: await j.readPendingPaymentReviews(record.actorId),
    }
  }, record)
  expect(result).toEqual({ passwordRejected: true, wrongAckRejected: true, retained: 1, after: [] })
})

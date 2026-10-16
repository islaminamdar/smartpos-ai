import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import OfflinePaymentReviews from '@/components/pos/offline-payments/OfflinePaymentReviews'
import DecisionForm from '@/components/pos/offline-payments/DecisionForm'
import {
  dubaiInstant,
  eligible,
  validateDecisionForCase,
} from '@/components/pos/offline-payments/decision'
import { paymentReviewDetailSchema } from '@/lib/pos/offline/payment-review-contracts'
import type { PendingPaymentReview } from '@/components/pos/offline-payments/journal'
import {
  reviewActor,
  reviewBranch,
  reviewDetail,
  reviewId,
  reviewRequest,
  reviewResolution,
} from './fixtures/payment-review-ui'
const storage = vi.hoisted(() => ({ records: [] as PendingPaymentReview[], fail: false }))
vi.mock('@/components/pos/offline-payments/journal', () => ({
  paymentReviewJournalEvent: 'review-test-event',
  samePaymentDecision: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
  readPendingPaymentReviews: vi.fn(async (actorId: string) =>
    storage.records.filter((r) => r.actorId === actorId)
  ),
  savePendingPaymentReview: vi.fn(async (r: PendingPaymentReview) => {
    if (storage.fail || storage.records.length) throw Error('Storage unavailable')
    storage.records.push(structuredClone(r))
  }),
  acknowledgePaymentReview: vi.fn(async (r: PendingPaymentReview) => {
    storage.records = storage.records.filter(
      (item) => item.request.requestId !== r.request.requestId
    )
  }),
}))
let detail = structuredClone(reviewDetail),
  post: ReturnType<
    typeof vi.fn<
      (body: { request: typeof reviewRequest; currentPassword: string }) => Promise<unknown>
    >
  >,
  getFails = false
beforeEach(() => {
  storage.records = []
  storage.fail = false
  getFails = false
  detail = structuredClone(reviewDetail)
  post = vi.fn(async () => {
    throw Error('lost response')
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return post(JSON.parse(init.body as string))
      if (getFails) throw Error('offline')
      return {
        ok: true,
        json: async () =>
          url.includes('/case?')
            ? detail
            : { branchId: reviewBranch, cases: [detail.summary], nextCursor: null },
      }
    })
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const mount = () =>
  render(
    <OfflinePaymentReviews actorId={reviewActor} branchId={reviewBranch} branchName="Bur Dubai" />
  )
async function openCase() {
  await screen.findByRole('button', { name: /Counter 2/ })
  fireEvent.click(screen.getByRole('button', { name: /Counter 2/ }))
  await screen.findByText('Record a completed outcome')
}
function fillForm() {
  fireEvent.change(screen.getByLabelText('Reason'), {
    target: { value: 'All collected money returned' },
  })
  for (const input of screen.getAllByLabelText(/Payment received/))
    fireEvent.change(input, { target: { value: '2026-01-01T08:00' } })
  for (const input of screen.getAllByLabelText(/Full return completed/))
    fireEvent.change(input, { target: { value: '2026-01-01T08:05' } })
  fireEvent.change(screen.getByLabelText('Cash return reference'), { target: { value: 'cash-1' } })
  fireEvent.change(screen.getByLabelText('Provider / terminal reference'), {
    target: { value: 'card-1' },
  })
  for (const input of screen.getAllByLabelText('Evidence note'))
    fireEvent.change(input, { target: { value: 'Verified full return' } })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.change(screen.getByLabelText('My current account password'), {
    target: { value: 'synthetic-only' },
  })
}
it('validates synthetic detail and exact return amounts, drawer and Dubai calendar dates', () => {
  expect(paymentReviewDetailSchema.parse(reviewDetail)).toEqual(reviewDetail)
  expect(eligible(reviewDetail)).toBe(true)
  expect(validateDecisionForCase(reviewRequest, reviewDetail)).toEqual(reviewRequest)
  expect(() =>
    validateDecisionForCase(
      {
        ...reviewRequest,
        evidence: [{ ...reviewRequest.evidence[0], amountFils: 1000 }, reviewRequest.evidence[1]],
      },
      reviewDetail
    )
  ).toThrow()
  expect(() =>
    validateDecisionForCase({ ...reviewRequest, cashDrawerShiftId: reviewId(30) }, reviewDetail)
  ).toThrow()
  expect(dubaiInstant('2026-01-01T08:00')).toBe('2026-01-01T04:00:00.000Z')
  expect(() => dubaiInstant('2026-02-30T08:00')).toThrow()
})
it('hides authorization-void option for mixed tender and resets consent after evidence edit', async () => {
  mount()
  await openCase()
  fillForm()
  expect(screen.queryByRole('option', { name: /authorization voided/ })).toBeNull()
  fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Changed evidence' } })
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  expect(screen.getByLabelText('My current account password')).toHaveValue('')
  expect(post).not.toHaveBeenCalled()
})
it('clears the password before calling persistence and prevents network when storage fails', async () => {
  storage.fail = true
  mount()
  await openCase()
  fillForm()
  fireEvent.click(screen.getByRole('button', { name: 'Record verified outcome' }))
  await screen.findByRole('alert')
  expect(post).not.toHaveBeenCalled()
  expect(storage.records).toEqual([])
  expect(screen.queryByDisplayValue('synthetic-only')).toBeNull()
})
it('lost POST keeps exact password-free decision, requires GET then fresh consent/password for same-id retry', async () => {
  mount()
  await openCase()
  fillForm()
  fireEvent.click(screen.getByRole('button', { name: 'Record verified outcome' }))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  await screen.findByRole('alert')
  const saved = structuredClone(storage.records[0])
  expect(JSON.stringify(saved)).not.toContain('synthetic-only')
  expect(screen.queryByRole('button', { name: 'Retry saved decision' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Check saved decision' }))
  await screen.findByText('Retry the exact saved decision')
  expect(screen.getByRole('checkbox')).not.toBeChecked()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.change(screen.getByLabelText('My current account password'), {
    target: { value: 'fresh-synthetic' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Retry saved decision' }))
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
  expect(post.mock.calls[1][0].request).toEqual(saved.request)
  expect(post.mock.calls[1][0].currentPassword).toBe('fresh-synthetic')
})
it('restores accepted exact decision after reload without POST and distinguishes signature/device pending', async () => {
  storage.records = [
    { actorId: reviewActor, branchId: reviewBranch, caseId: reviewId(3), request: reviewRequest },
  ]
  detail = {
    ...detail,
    decisionRequest: reviewRequest,
    resolution: reviewResolution(),
    summary: { ...detail.summary, state: 'delivery_pending' },
  }
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Check saved decision' }))
  await screen.findByText(/Decision recorded; signature still pending/)
  await waitFor(() => expect(storage.records).toHaveLength(0))
  expect(screen.getByText(/Original Android device confirmation: not implemented/)).toBeVisible()
  expect(post).not.toHaveBeenCalled()
})
it('failed fresh case read retains visible record but removes all decision controls', async () => {
  mount()
  await openCase()
  getFails = true
  fireEvent.click(screen.getByRole('button', { name: 'Check case status' }))
  await screen.findByRole('alert')
  expect(screen.getByText('Original saved payment')).toBeVisible()
  expect(screen.queryByText('Record a completed outcome')).toBeNull()
})
it('superseded decision requires explicit local-only dismissal and never posts', async () => {
  storage.records = [
    { actorId: reviewActor, branchId: reviewBranch, caseId: reviewId(3), request: reviewRequest },
  ]
  const other = { ...reviewRequest, requestId: reviewId(31) }
  detail = {
    ...detail,
    decisionRequest: other,
    resolution: { ...reviewResolution(other), managerActorId: reviewId(32) },
    summary: { ...detail.summary, state: 'delivery_pending' },
  }
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Check saved decision' }))
  const button = await screen.findByRole('button', { name: 'Dismiss this local retry' })
  expect(button).toBeDisabled()
  expect(storage.records).toHaveLength(1)
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(button)
  await waitFor(() => expect(storage.records).toHaveLength(0))
  expect(post).not.toHaveBeenCalled()
})
it('changing actor discards delayed detail and entered password', async () => {
  const view = mount()
  await openCase()
  fillForm()
  view.rerender(
    <OfflinePaymentReviews actorId={reviewId(44)} branchId={reviewBranch} branchName="Bur Dubai" />
  )
  expect(screen.queryByDisplayValue('synthetic-only')).toBeNull()
  expect(screen.queryByText('Record a completed outcome')).toBeNull()
})
it('backgrounding clears consent/password and requires a fresh case read', async () => {
  mount()
  await openCase()
  fillForm()
  Object.defineProperty(document, 'hidden', { configurable: true, value: true })
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(screen.queryByDisplayValue('synthetic-only')).toBeNull()
  expect(screen.queryByText('Record a completed outcome')).toBeNull()
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
})
it('card-only can attest a void; form rejects completion before observation and never submits', () => {
  const submit = vi.fn()
  const cardDetail = {
    ...reviewDetail,
    summary: { ...reviewDetail.summary, cashFils: 0, cardFils: 4200 },
  }
  render(<DecisionForm detail={cardDetail} disabled={false} onSubmit={submit} />)
  fireEvent.change(screen.getByLabelText('Outcome'), { target: { value: 'payment_voided' } })
  fireEvent.change(screen.getByLabelText('Reason'), {
    target: { value: 'Authorization void confirmed' },
  })
  fireEvent.change(screen.getByLabelText(/Authorization observed/), {
    target: { value: '2026-01-01T08:05' },
  })
  fireEvent.change(screen.getByLabelText(/Void completed/), {
    target: { value: '2026-01-01T08:00' },
  })
  fireEvent.change(screen.getByLabelText('Provider / terminal reference'), {
    target: { value: 'void-1' },
  })
  fireEvent.change(screen.getByLabelText('Evidence note'), { target: { value: 'Void checked' } })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.change(screen.getByLabelText('My current account password'), {
    target: { value: 'synthetic' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Record verified outcome' }))
  expect(submit).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toBeVisible()
})

it('feature-off recovery can read an exact pending request but never offers a retry', async () => {
  storage.records = [
    { actorId: reviewActor, branchId: reviewBranch, caseId: reviewId(3), request: reviewRequest },
  ]
  render(
    <OfflinePaymentReviews
      actorId={reviewActor}
      branchId={reviewBranch}
      branchName="Bur Dubai"
      allowDecisions={false}
    />
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Check saved decision' }))
  await screen.findByText('Original saved payment')
  expect(screen.queryByRole('button', { name: 'Retry saved decision' })).toBeNull()
  expect(storage.records).toHaveLength(1)
  expect(post).not.toHaveBeenCalled()
})
it('a different manager identity cannot acknowledge the local exact request', async () => {
  storage.records = [
    { actorId: reviewActor, branchId: reviewBranch, caseId: reviewId(3), request: reviewRequest },
  ]
  detail = {
    ...detail,
    decisionRequest: reviewRequest,
    resolution: { ...reviewResolution(), managerActorId: reviewId(99) },
    summary: { ...detail.summary, state: 'delivery_pending' },
  }
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Check saved decision' }))
  await screen.findByText('Accepted manager decision')
  expect(storage.records).toHaveLength(1)
  expect(screen.queryByRole('button', { name: 'Dismiss this local retry' })).toBeNull()
})
it('late old-scope detail cannot repopulate the new account view', async () => {
  let release!: (value: unknown) => void
  const originalFetch = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/case?'))
        return new Promise((resolve) => {
          release = resolve
        })
      return originalFetch(url, init)
    })
  )
  const view = mount()
  fireEvent.click(await screen.findByRole('button', { name: /Counter 2/ }))
  await waitFor(() => expect(release).toBeTypeOf('function'))
  view.rerender(
    <OfflinePaymentReviews actorId={reviewId(77)} branchId={reviewBranch} branchName="Bur Dubai" />
  )
  await act(async () => {
    release({ ok: true, json: async () => reviewDetail })
  })
  expect(screen.queryByText('Original saved payment')).toBeNull()
  expect(screen.queryByText('Record a completed outcome')).toBeNull()
})

it('unknown holds prevent attestation even if the response says canDecide', async () => {
  detail.capabilities.holdCode = 'unknown_future_hold'
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /Counter 2/ }))
  await screen.findByText('Original saved payment')
  expect(screen.queryByText('Record a completed outcome')).toBeNull()
  expect(post).not.toHaveBeenCalled()
})
it('refreshing the case list invalidates an already open decision form until detail is rechecked', async () => {
  mount()
  await openCase()
  fillForm()
  fireEvent.click(screen.getByRole('button', { name: 'Refresh cases' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh cases' })).toBeEnabled())
  expect(screen.queryByText('Record a completed outcome')).toBeNull()
  expect(screen.queryByDisplayValue('synthetic-only')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Check case status' }))
  await screen.findByText('Record a completed outcome')
  expect(screen.getByRole('checkbox')).not.toBeChecked()
})
it('saved retry shows every immutable evidence note and observed/completed time before consent', async () => {
  storage.records = [
    { actorId: reviewActor, branchId: reviewBranch, caseId: reviewId(3), request: reviewRequest },
  ]
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Check saved decision' }))
  await screen.findByText('Same original drawer, counted with customer')
  expect(screen.getByText('Full card return confirmed at terminal')).toBeVisible()
  expect(screen.getAllByText(/Payment received: 01 Jan 2026, 08:00/)).toHaveLength(2)
})

import { StrictMode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import KitchenReturnNotices from '@/components/pos/KitchenReturnNotices'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  props = { actorId: id(1), branchId: id(2), deviceId: id(3) }
const notice = {
  id: id(4),
  branchId: props.branchId,
  orderId: id(5),
  invoiceId: id(6),
  invoiceNumber: 'TEST-INV-0000000001',
  creditNumber: 'TEST-CN-0000000001',
  issuedAt: '2026-10-16T01:02:03Z',
  reason: 'Returned synthetic portion',
  fullyReturned: false,
  lines: [
    {
      originalLineNumber: 1,
      productId: id(7),
      name: 'Synthetic sweet',
      unit: 'kg',
      quantityMilli: 250,
      remainingQuantityMilli: 750,
    },
  ],
}
const page = {
    status: 'ready',
    branchId: props.branchId,
    pendingCount: 1,
    notices: [notice],
    nextCursor: null,
  },
  res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it('shows exact returned and remaining quantities and acknowledges only matched result', async () => {
  const done = vi.fn(),
    fetcher = vi
      .fn()
      .mockResolvedValueOnce(res(page))
      .mockResolvedValueOnce(
        res({
          status: 'acknowledged',
          branchId: props.branchId,
          noticeId: notice.id,
          replayed: false,
        })
      )
      .mockResolvedValueOnce(res({ ...page, pendingCount: 0, notices: [] }))
  vi.stubGlobal('fetch', fetcher)
  render(<KitchenReturnNotices {...props} onAcknowledged={done} />)
  expect(await screen.findByText(/0.25 kg returned; 0.75 kg remain/)).toBeTruthy()
  fireEvent.click(screen.getByText('I checked this return with the kitchen'))
  await waitFor(() => expect(done).toHaveBeenCalledTimes(1))
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
    branchId: props.branchId,
    deviceId: props.deviceId,
    noticeId: notice.id,
  })
  expect(fetcher.mock.calls[1][1].headers['x-pos-actor']).toBe(props.actorId)
})
it('keeps failed or mismatched acknowledgement visible for exact retry', async () => {
  const done = vi.fn()
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(res(page))
      .mockResolvedValueOnce(
        res({ status: 'acknowledged', branchId: props.branchId, noticeId: id(9), replayed: false })
      )
  )
  render(<KitchenReturnNotices {...props} onAcknowledged={done} />)
  fireEvent.click(await screen.findByText('I checked this return with the kitchen'))
  expect(await screen.findByRole('alert')).toHaveTextContent('not confirmed')
  expect(screen.getByText(notice.reason)).toBeTruthy()
  expect(done).not.toHaveBeenCalled()
})
it('drops late previous-account notices on scope change', async () => {
  let complete!: (r: Response) => void
  const delayed = new Promise<Response>((r) => {
    complete = r
  })
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockReturnValueOnce(delayed)
      .mockResolvedValueOnce(res({ ...page, pendingCount: 0, notices: [] }))
  )
  const view = render(<KitchenReturnNotices {...props} />)
  view.rerender(<KitchenReturnNotices {...props} actorId={id(8)} />)
  await screen.findByText('0 awaiting acknowledgement')
  await act(async () => complete(res(page)))
  expect(screen.queryByText(notice.reason)).toBeNull()
})
it('disabled prevents acknowledgement and failed refresh does not claim zero pending', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValueOnce(res(page)).mockResolvedValueOnce(res({}, 503))
  )
  render(<KitchenReturnNotices {...props} disabled />)
  expect(await screen.findByText('I checked this return with the kitchen')).toBeDisabled()
  fireEvent.click(screen.getByText('Refresh return notices'))
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be checked')
  expect(screen.queryByText('0 awaiting acknowledgement')).toBeNull()
})

it('polls only while visible and refreshes immediately on resume without overlapping acknowledgement', async () => {
  vi.useFakeTimers()
  let visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
    () => visibility as DocumentVisibilityState
  )
  let finish!: (response: Response) => void
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(res(page)))
  vi.stubGlobal('fetch', fetcher)
  const view = render(<KitchenReturnNotices {...props} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(fetcher).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000)
  })
  expect(fetcher).toHaveBeenCalledTimes(2)
  visibility = 'hidden'
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20000)
  })
  expect(fetcher).toHaveBeenCalledTimes(2)
  visibility = 'visible'
  await act(async () => {
    fireEvent(document, new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(fetcher).toHaveBeenCalledTimes(3)
  fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve
      })
  )
  fireEvent.click(screen.getByText('I checked this return with the kitchen'))
  fireEvent.click(screen.getByText('I checked this return with the kitchen'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20000)
    fireEvent(document, new Event('visibilitychange'))
  })
  expect(fetcher).toHaveBeenCalledTimes(4)
  await act(async () => {
    finish(
      res({
        status: 'acknowledged',
        branchId: props.branchId,
        noticeId: notice.id,
        replayed: false,
      })
    )
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(fetcher).toHaveBeenCalledTimes(5)
  view.unmount()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20000)
    fireEvent(document, new Event('visibilitychange'))
  })
  expect(fetcher).toHaveBeenCalledTimes(5)
  vi.restoreAllMocks()
})
it('poll failure clears stale notices and later visible refresh restores an authoritative count', async () => {
  vi.useFakeTimers()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(res(page))
    .mockResolvedValueOnce(res({}, 503))
    .mockResolvedValueOnce(res({ ...page, notices: [], pendingCount: 0 }))
  vi.stubGlobal('fetch', fetcher)
  render(<KitchenReturnNotices {...props} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(screen.getByText(notice.reason)).toBeTruthy()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10000)
  })
  expect(screen.queryByText(notice.reason)).toBeNull()
  expect(screen.getByRole('alert')).toHaveTextContent('could not be checked')
  expect(screen.queryByText('0 awaiting acknowledgement')).toBeNull()
  await act(async () => {
    fireEvent(document, new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(screen.getByText('0 awaiting acknowledgement')).toBeTruthy()
  vi.restoreAllMocks()
})

it('keeps a current initial read under StrictMode effect replay', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => Promise.resolve(res(page)))
  )
  render(
    <StrictMode>
      <KitchenReturnNotices {...props} />
    </StrictMode>
  )
  expect(await screen.findByText(notice.reason)).toBeTruthy()
  expect(screen.getByText('I checked this return with the kitchen')).not.toBeDisabled()
})

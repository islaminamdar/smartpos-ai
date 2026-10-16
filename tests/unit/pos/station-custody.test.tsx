import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ configuration: vi.fn(), work: vi.fn() }))
vi.mock('@/lib/pos/kitchen-station-journal', () => ({
  stationJournalEvent: 'station-config-test',
  readPendingStationRequests: m.configuration,
}))
vi.mock('@/lib/pos/kitchen-station-work-journal', () => ({
  stationWorkJournalEvent: 'station-work-test',
  readPendingStationWorkRequests: m.work,
}))
import { useStationCustody } from '@/components/pos/kitchen-stations/useStationCustody'
const deferred = () => {
  let resolve!: (value: unknown[]) => void
  let reject!: (error: Error) => void
  const promise = new Promise<unknown[]>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
beforeEach(() => {
  vi.resetAllMocks()
  m.configuration.mockResolvedValue([])
  m.work.mockResolvedValue([])
})
afterEach(cleanup)
it('checks all actor branches and holds until both journals finish', async () => {
  const slow = deferred()
  m.work.mockReturnValueOnce(slow.promise)
  const { result } = renderHook(() => useStationCustody('actor-a'))
  expect(result.current.held).toBe(true)
  await act(async () => slow.resolve([{ command: { branchId: 'another-branch' } }]))
  expect(result.current.ready).toBe(true)
  expect(result.current.work).toBe(true)
  expect(result.current.held).toBe(true)
  m.work.mockResolvedValue([])
  await act(async () => {
    window.dispatchEvent(new Event('station-work-test'))
  })
  await waitFor(() => expect(result.current.held).toBe(false))
  expect(m.configuration).toHaveBeenCalledWith('actor-a')
  expect(m.work).toHaveBeenCalledWith('actor-a')
})
it('an older empty read cannot clear a newer pending request', async () => {
  const old = deferred()
  m.configuration.mockReturnValueOnce(old.promise)
  const { result } = renderHook(() => useStationCustody('actor-a'))
  m.configuration.mockResolvedValue([{}])
  await act(async () => {
    window.dispatchEvent(new Event('station-config-test'))
  })
  await waitFor(() => expect(result.current.configuration).toBe(true))
  await act(async () => old.resolve([]))
  expect(result.current.configuration).toBe(true)
  expect(result.current.held).toBe(true)
})
it('stale read failures cannot erase the current account success', async () => {
  const old = deferred()
  m.configuration.mockReturnValueOnce(old.promise)
  const { result, rerender } = renderHook(({ actor }) => useStationCustody(actor), {
    initialProps: { actor: 'actor-a' },
  })
  rerender({ actor: 'actor-b' })
  await waitFor(() => expect(result.current.ready).toBe(true))
  await act(async () => old.reject(Error('stale corrupt scope')))
  expect(result.current.ready).toBe(true)
  expect(result.current.held).toBe(false)
})
it('fails closed on unreadable storage and explicit checks reject', async () => {
  m.work.mockRejectedValue(Error('corrupt saved command'))
  const { result } = renderHook(() => useStationCustody('actor-a'))
  await waitFor(() => expect(m.work).toHaveBeenCalled())
  expect(result.current.ready).toBe(false)
  expect(result.current.held).toBe(true)
  await act(async () => {
    await expect(result.current.check()).rejects.toThrow('corrupt saved command')
  })
  m.work.mockResolvedValue([])
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
  await waitFor(() => expect(result.current.held).toBe(false))
})

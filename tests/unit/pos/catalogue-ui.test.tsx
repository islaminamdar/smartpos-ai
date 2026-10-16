import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import CatalogueManager from '@/components/pos/CatalogueManager'
const branch = '10000000-0000-4000-8000-000000000001'
const device = '20000000-0000-4000-8000-000000000002'
const product = {
  id: '30000000-0000-4000-8000-000000000003',
  branchId: branch,
  name: 'Test sweets',
  category: 'Sweets',
  imageUrl: null,
  unit: 'kg',
  unitPriceFils: 1000,
  taxRateBps: 500,
  active: true,
  revision: 1,
}
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
beforeEach(() => {
  sessionStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
it('persists an uncertain menu request and retries the exact ID after reopening the menu', async () => {
  const requests: Record<string, any>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        requests.push(body)
        if (requests.length === 1) throw new TypeError('Network interrupted after send')
        return response({
          status: 'updated',
          requestId: body.id,
          replayed: true,
          product: { ...body.product, branchId: branch, revision: 2 },
        })
      }
      return response({ status: 'ready', products: [product] })
    })
  )
  const changed = vi.fn(async () => {})
  const first = render(
    <CatalogueManager branchId={branch} deviceId={device} disabled={false} onChanged={changed} />
  )
  fireEvent.click(await screen.findByRole('button', { name: /Test sweets/ }))
  fireEvent.change(screen.getByLabelText('Reason for this change'), {
    target: { value: 'Confirmed menu price' },
  })
  fireEvent.change(screen.getByLabelText('Price including VAT (AED)'), {
    target: { value: '12.00' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save menu item' }))
  await screen.findByText(/The change could not be confirmed/)
  expect(requests).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Add item' })).toBeDisabled()
  const key = `pos-menu-request:${branch}:${device}`
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(requests[0])
  first.unmount()
  render(
    <CatalogueManager branchId={branch} deviceId={device} disabled={false} onChanged={changed} />
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Retry saved change' }))
  await screen.findByText(/Test sweets saved/)
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
  expect(sessionStorage.getItem(key)).toBeNull()
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
})
it('distinguishes a saved edit from a failed refresh', async () => {
  let reads = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        return response({
          status: 'updated',
          requestId: body.id,
          replayed: false,
          product: { ...body.product, branchId: branch, revision: 2 },
        })
      }
      if (++reads > 1) throw new TypeError('Refresh failed')
      return response({ status: 'ready', products: [product] })
    })
  )
  render(
    <CatalogueManager
      branchId={branch}
      deviceId={device}
      disabled={false}
      onChanged={async () => {}}
    />
  )
  fireEvent.click(await screen.findByRole('button', { name: /Test sweets/ }))
  fireEvent.change(screen.getByLabelText('Reason for this change'), {
    target: { value: 'Reviewed' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save menu item' }))
  await screen.findByText(/The item was saved, but refreshing the screen failed/)
  expect(screen.queryByRole('button', { name: 'Retry saved change' })).not.toBeInTheDocument()
  expect(sessionStorage.getItem(`pos-menu-request:${branch}:${device}`)).toBeNull()
})

it('does not send a menu change when its recovery record cannot be saved', async () => {
  const fetcher = vi.fn(async () => response({ status: 'ready', products: [product] }))
  vi.stubGlobal('fetch', fetcher)
  render(
    <CatalogueManager
      branchId={branch}
      deviceId={device}
      disabled={false}
      onChanged={async () => {}}
    />
  )
  fireEvent.click(await screen.findByRole('button', { name: /Test sweets/ }))
  fireEvent.change(screen.getByLabelText('Reason for this change'), {
    target: { value: 'Reviewed' },
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Storage full')
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save menu item' }))
  await screen.findByText(/No change was sent/)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Add item' })).toBeDisabled()
})

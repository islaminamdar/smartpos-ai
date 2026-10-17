import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import CatalogueManager from '@/components/pos/CatalogueManager'
import MenuPhotoEditor from '@/components/pos/MenuPhotoEditor'
import type { CatalogueUpdate } from '@/lib/pos/server/catalogue'
import { MENU_PHOTO_MAX_SOURCE_BYTES } from '@/lib/pos/menu-photo'

const branch = '10000000-0000-4000-8000-000000000001'
const otherBranch = '10000000-0000-4000-8000-000000000002'
const device = '20000000-0000-4000-8000-000000000001'
const productId = '30000000-0000-4000-8000-000000000001'
const imageId = '40000000-0000-4000-8000-000000000001'
const sourceImage = '/pos-assets/menu/I351571363A.webp'
const uploadedImage = `/pos-assets/menu/upload_${imageId.replaceAll('-', '')}.webp`
const product = {
  id: productId,
  branchId: branch,
  name: 'Test sweets',
  category: 'Sweets',
  imageUrl: sourceImage,
  unit: 'kg',
  unitPriceFils: 1000,
  taxRateBps: 500,
  active: true,
  revision: 1,
}
const uploaded = {
  status: 'ready',
  image: {
    id: imageId,
    branchId: branch,
    imageUrl: uploadedImage,
    sha256: 'a'.repeat(64),
    width: 800,
    height: 600,
    byteLength: 1000,
  },
  replayed: false,
}
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
const photo = () =>
  new File(['synthetic bytes; route tests exercise actual decode'], 'authentic-sweets.webp', {
    type: 'image/webp',
  })
const choose = (file = photo()) => {
  fireEvent.change(screen.getByLabelText('Choose item photo'), { target: { files: [file] } })
  return file
}
const deferred = () => {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function Editor({
  disabled = false,
  onChange = vi.fn(),
  onBusyChange = vi.fn(),
  onFilePending = vi.fn(),
  branchId = branch,
}: {
  disabled?: boolean
  onChange?: (url: string | null) => void
  onBusyChange?: (busy: boolean) => void
  onFilePending?: (pending: boolean) => void
  branchId?: string
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(sourceImage)
  return (
    <MenuPhotoEditor
      branchId={branchId}
      deviceId={device}
      itemName="Test sweets"
      savedImageUrl={sourceImage}
      imageUrl={imageUrl}
      disabled={disabled}
      onChange={(url) => {
        setImageUrl(url)
        onChange(url)
      }}
      onBusyChange={onBusyChange}
      onFilePending={onFilePending}
    />
  )
}

beforeEach(() => {
  sessionStorage.clear()
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(() => 'blob:local-preview'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('menu photo selection and public upload', () => {
  it('keeps selection local until explicit upload and stages only the confirmed URL', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(uploaded))
    vi.stubGlobal('fetch', fetcher)
    const changed = vi.fn()
    const pending = vi.fn()
    render(<Editor onChange={changed} onFilePending={pending} />)
    expect(screen.getByText(/Uploaded photos are public/)).toBeInTheDocument()
    const file = choose()
    expect(fetcher).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
    expect(pending).toHaveBeenLastCalledWith(true)
    expect(screen.getByAltText('Selected photo preview')).toHaveAttribute(
      'src',
      'blob:local-preview'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Upload photo' }))
    await screen.findByText(/Photo uploaded. Save the menu item/)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe(
      `/api/pos/catalogue/photo?branchId=${branch}&deviceId=${device}`
    )
    expect(fetcher.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: file,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'image/webp' },
      })
    )
    expect(changed).toHaveBeenCalledExactlyOnceWith(uploadedImage)
    expect(pending).toHaveBeenLastCalledWith(false)
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-preview'))
  })

  it('rejects unsupported, empty and oversized files without sending data', () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const changed = vi.fn()
    render(<Editor onChange={changed} />)
    for (const file of [
      new File(['<svg/>'], 'picture.svg', { type: 'image/svg+xml' }),
      new File([], 'empty.png', { type: 'image/png' }),
      new File([new Uint8Array(MENU_PHOTO_MAX_SOURCE_BYTES + 1)], 'large.jpg', {
        type: 'image/jpeg',
      }),
    ]) {
      choose(file)
      expect(screen.getByRole('alert')).toHaveTextContent('Choose a still JPEG, PNG or WebP')
      expect(screen.queryByRole('button', { name: 'Upload photo' })).not.toBeInTheDocument()
    }
    expect(fetcher).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
  })

  it('allows an uncertain upload to retry the exact same File and only attaches the confirmed result', async () => {
    const file = photo()
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Lost response'))
      .mockResolvedValueOnce(response({ ...uploaded, replayed: true }))
    vi.stubGlobal('fetch', fetcher)
    const changed = vi.fn()
    render(<Editor onChange={changed} />)
    choose(file)
    fireEvent.click(screen.getByRole('button', { name: 'Upload photo' }))
    await screen.findByText(/The upload could not be confirmed/)
    expect(changed).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Upload photo' }))
    await screen.findByText(/Photo uploaded. Save the menu item/)
    expect(fetcher.mock.calls.map((call) => call[1].body)).toEqual([file, file])
    expect(changed).toHaveBeenCalledExactlyOnceWith(uploadedImage)
  })

  it('guards double clicks and controls while processing, then ignores a late unmounted response', async () => {
    const waiting = deferred()
    const fetcher = vi.fn<typeof fetch>(() => waiting.promise)
    vi.stubGlobal('fetch', fetcher)
    const changed = vi.fn()
    const busy = vi.fn()
    const view = render(<Editor onChange={changed} onBusyChange={busy} />)
    choose()
    const upload = screen.getByRole('button', { name: 'Upload photo' })
    fireEvent.click(upload)
    fireEvent.click(upload)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Choose item photo')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove photo' })).toBeDisabled()
    expect(busy).toHaveBeenLastCalledWith(true)
    const signal = fetcher.mock.calls[0][1]?.signal as AbortSignal
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => waiting.resolve(response(uploaded)))
    expect(changed).not.toHaveBeenCalled()
  })

  it.each([
    { ...uploaded, image: { ...uploaded.image, branchId: otherBranch } },
    { ...uploaded, image: { ...uploaded.image, imageUrl: 'https://foreign.example/image.webp' } },
    { ...uploaded, extra: 'untrusted' },
  ])('rejects mismatched or invalid confirmations', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(body))
    )
    const changed = vi.fn()
    render(<Editor onChange={changed} />)
    choose()
    fireEvent.click(screen.getByRole('button', { name: 'Upload photo' }))
    await screen.findByText(/The upload could not be confirmed/)
    expect(changed).not.toHaveBeenCalled()
  })

  it('keeps remove and restore local and preserves original public link disclosure', () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const changed = vi.fn()
    render(<Editor onChange={changed} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove photo' }))
    expect(changed).toHaveBeenLastCalledWith(null)
    expect(screen.getByText(/Photo will be removed when you save/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Restore saved photo' }))
    expect(changed).toHaveBeenLastCalledWith(sourceImage)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'authentication_required', 'Sign in again'],
    [403, 'manager_access_required', 'Only an authorised manager'],
    [413, 'payload_too_large', 'photo is too large'],
    [422, 'menu_photo_animation', 'could not be processed'],
    [429, 'menu_photo_rate_limit', 'upload limit has been reached'],
    [409, 'menu_photo_quota', 'photo storage limit'],
    [503, 'menu_photo_busy', 'Another photo is being processed'],
  ])('explains rejected upload %s while retaining local preview', async (status, code, text) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ code }, Number(status)))
    )
    render(<Editor />)
    choose()
    fireEvent.click(screen.getByRole('button', { name: 'Upload photo' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('alert')).toHaveTextContent(String(text))
    expect(screen.getByAltText('Selected photo preview')).toBeInTheDocument()
  })

  it('honours an existing financial or offline hold', () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    render(<Editor disabled />)
    expect(screen.getByLabelText('Choose item photo')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove photo' })).toBeDisabled()
    choose()
    expect(screen.queryByRole('button', { name: 'Upload photo' })).not.toBeInTheDocument()
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('catalogue photo assignment and recovery', () => {
  it('blocks save for a selected file, uploads separately, and retains only URL in the exact uncertain catalogue journal', async () => {
    const commands: CatalogueUpdate[] = []
    const waiting = deferred()
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/catalogue/photo?')) return waiting.promise
      if (init?.method === 'POST') {
        const command = JSON.parse(String(init.body))
        commands.push(command)
        if (commands.length === 1) throw new TypeError('Lost saved-item response')
        return response({
          status: 'updated',
          requestId: command.id,
          replayed: true,
          product: { ...command.product, branchId: branch, revision: 2 },
        })
      }
      return response({ status: 'ready', products: [product] })
    })
    vi.stubGlobal('fetch', fetcher)
    const changed = vi.fn(async () => {})
    render(
      <CatalogueManager branchId={branch} deviceId={device} disabled={false} onChanged={changed} />
    )
    fireEvent.click(await screen.findByRole('button', { name: /Test sweets/ }))
    choose()
    const save = screen.getByRole('button', { name: 'Save menu item' })
    expect(save).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Upload photo' }))
    expect(screen.getByRole('button', { name: 'Add item' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Test sweets/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Refresh menu' })).toBeDisabled()
    expect(save).toBeDisabled()
    expect(commands).toHaveLength(0)
    await act(async () => waiting.resolve(response(uploaded)))
    await screen.findByText(/Photo uploaded. Save the menu item/)
    expect(save).toBeEnabled()
    expect(commands).toHaveLength(0)
    fireEvent.change(screen.getByLabelText('Reason for this change'), {
      target: { value: 'Restaurant photo approved' },
    })
    fireEvent.click(save)
    await screen.findByText(/The change could not be confirmed/)
    const key = `pos-menu-request:${branch}:${device}`
    const journal = sessionStorage.getItem(key)!
    expect(JSON.parse(journal).product.imageUrl).toBe(uploadedImage)
    expect(journal).not.toContain('synthetic bytes')
    expect(journal).not.toContain('blob:')
    expect(journal).not.toContain('authentic-sweets.webp')
    fireEvent.click(screen.getByRole('button', { name: 'Retry saved change' }))
    await screen.findByText(/Test sweets saved/)
    expect(commands[1]).toEqual(commands[0])
    expect(sessionStorage.getItem(key)).toBeNull()
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('does not carry a selected photo into another item, including reselecting the same item', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response({
          status: 'ready',
          products: [product, { ...product, id: imageId, name: 'Other item', imageUrl: null }],
        })
      )
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
    choose()
    fireEvent.click(screen.getByRole('button', { name: /Test sweets/ }))
    expect(screen.queryByAltText('Selected photo preview')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save menu item' })).toBeEnabled()
    choose()
    fireEvent.click(screen.getByRole('button', { name: /Other item/ }))
    expect(screen.queryByAltText('Selected photo preview')).not.toBeInTheDocument()
    expect(screen.getByText('Add a clear photo of this item.')).toBeInTheDocument()
  })

  it('aborts on a branch change and cannot stage a late upload in the new branch', async () => {
    const waiting = deferred()
    let signal: AbortSignal | null | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/catalogue/photo?')) {
          signal = init?.signal
          return waiting.promise
        }
        const branchId = new URL(url, 'http://localhost').searchParams.get('branchId')
        return response({ status: 'ready', products: [{ ...product, branchId, imageUrl: null }] })
      })
    )
    const view = render(
      <CatalogueManager
        branchId={branch}
        deviceId={device}
        disabled={false}
        onChanged={async () => {}}
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: /Test sweets/ }))
    choose()
    fireEvent.click(screen.getByRole('button', { name: 'Upload photo' }))
    view.rerender(
      <CatalogueManager
        branchId={otherBranch}
        deviceId={device}
        disabled={false}
        onChanged={async () => {}}
      />
    )
    expect(signal?.aborted).toBe(true)
    fireEvent.click(await screen.findByRole('button', { name: /Test sweets/ }))
    await act(async () => waiting.resolve(response(uploaded)))
    expect(screen.queryByText(/Photo uploaded/)).not.toBeInTheDocument()
    expect(screen.getByText('Add a clear photo of this item.')).toBeInTheDocument()
  })
})

describe('temporary illustration in the photo editor', () => {
  it('labels a fallback and immediately gives an uploaded real photo precedence', () => {
    const props = {
      productId: 'dc0f1421-33f2-55a5-bf17-eee5d3236d7c',
      branchId: '79d4b844-1fd4-4cdf-a32f-db9329d75f3a',
      deviceId: device,
      itemName: 'SAMOSA PAV',
      savedImageUrl: null,
      imageUrl: null as string | null,
      disabled: false,
      onChange: vi.fn(),
      onBusyChange: vi.fn(),
      onFilePending: vi.fn(),
    }
    const { rerender } = render(<MenuPhotoEditor {...props} />)
    expect(screen.getByAltText(/Temporary illustration: Samosa/)).toHaveAttribute(
      'src',
      '/pos-assets/menu-illustrations/samosa-pav.webp'
    )
    expect(screen.getByText('Temporary illustration')).toBeVisible()
    expect(screen.getByText(/not a photograph of your serving/)).toBeVisible()
    expect(props.onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Remove photo' })).toBeNull()
    rerender(<MenuPhotoEditor {...props} imageUrl={uploadedImage} />)
    expect(screen.getByAltText('Menu photo for SAMOSA PAV')).toHaveAttribute('src', uploadedImage)
    expect(screen.queryByText('Temporary illustration')).toBeNull()
  })
})

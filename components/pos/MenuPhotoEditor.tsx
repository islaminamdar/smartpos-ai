'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { ImagePlus } from 'lucide-react'
import { temporaryMenuIllustration } from '@/lib/pos/menu-illustrations'
import {
  MENU_PHOTO_MAX_SOURCE_BYTES,
  MENU_PHOTO_SOURCE_TYPES,
  menuPhotoResultSchema,
} from '@/lib/pos/menu-photo'
import styles from './MenuPhotoEditor.module.css'

type Props = {
  productId?: string
  branchId: string
  deviceId: string
  itemName: string
  savedImageUrl: string | null
  imageUrl: string | null
  disabled: boolean
  onChange: (imageUrl: string | null) => void
  onBusyChange: (busy: boolean) => void
  onFilePending: (pending: boolean) => void
}

function failure(status: number, code?: string): string {
  if (code === 'menu_photo_quota')
    return 'This branch has reached its photo storage limit. Contact your administrator before uploading more photos.'
  if (code === 'menu_photo_busy')
    return 'Another photo is being processed. Wait a moment, then retry this photo.'
  if (status === 401) return 'Sign in again, then choose this photo and retry the upload.'
  if (status === 403)
    return 'Only an authorised manager on this enrolled counter can upload a photo.'
  if (status === 413) return 'This photo is too large. Choose a JPEG, PNG or WebP up to 5 MB.'
  if (status === 415 || status === 422)
    return 'This photo could not be processed. Choose a still JPEG, PNG or WebP up to 16 megapixels.'
  if (status === 429)
    return 'The photo upload limit has been reached. Try again later or contact your administrator.'
  return 'The upload could not be confirmed. Retry the same photo. Your menu item has not changed.'
}

/** Upload stores a public photo; the enclosing catalogue command owns assignment. */
export default function MenuPhotoEditor(props: Props) {
  const { branchId, deviceId, itemName, savedImageUrl, imageUrl, disabled } = props
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const mounted = useRef(false)
  const lock = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const current = useRef(props)
  current.current = props
  const descriptionId = useId()
  const fileId = useId()

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      controller.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (!file) {
      setPreview(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const clearFile = () => {
    setFile(null)
    if (input.current) input.current.value = ''
    current.current.onFilePending(false)
  }

  function choose(candidate: File | undefined) {
    if (disabled || lock.current || !candidate) return
    setError('')
    setNotice('')
    if (
      !MENU_PHOTO_SOURCE_TYPES.some((type) => type === candidate.type) ||
      candidate.size === 0 ||
      candidate.size > MENU_PHOTO_MAX_SOURCE_BYTES
    ) {
      clearFile()
      setError('Choose a still JPEG, PNG or WebP photo between 1 byte and 5 MB.')
      return
    }
    setFile(candidate)
    current.current.onFilePending(true)
  }

  async function upload() {
    if (disabled || lock.current || !file) return
    lock.current = true
    setBusy(true)
    current.current.onBusyChange(true)
    setError('')
    setNotice('')
    const abort = new AbortController()
    controller.current = abort
    const timeout = setTimeout(() => abort.abort(), 30_000)
    const originalScope = `${branchId}:${deviceId}`
    const stillCurrent = () =>
      mounted.current && `${current.current.branchId}:${current.current.deviceId}` === originalScope
    try {
      const response = await fetch(
        `/api/pos/catalogue/photo?branchId=${encodeURIComponent(branchId)}&deviceId=${encodeURIComponent(deviceId)}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Content-Type': file.type },
          body: file,
          signal: abort.signal,
        }
      )
      if (!stillCurrent()) return
      if (!response.ok) {
        const detail: unknown = await response.json().catch(() => null)
        if (!stillCurrent()) return
        const code =
          detail &&
          typeof detail === 'object' &&
          'code' in detail &&
          typeof detail.code === 'string'
            ? detail.code
            : undefined
        setError(failure(response.status, code))
        return
      }
      const result = menuPhotoResultSchema.parse(await response.json())
      if (!stillCurrent()) return
      if (result.image.branchId !== branchId) throw new Error('photo_scope_mismatch')
      current.current.onChange(result.image.imageUrl)
      clearFile()
      setNotice('Photo uploaded. Save the menu item to use it at the counter.')
    } catch {
      if (stillCurrent()) setError(failure(503))
    } finally {
      clearTimeout(timeout)
      if (stillCurrent()) {
        lock.current = false
        setBusy(false)
        current.current.onBusyChange(false)
      }
    }
  }

  const illustration = !preview
    ? temporaryMenuIllustration({ id: props.productId, branchId, imageUrl })
    : null
  const shownImage = preview || imageUrl || illustration?.src
  const changed = imageUrl !== savedImageUrl
  return (
    <section className={styles.editor} aria-label="Menu photo" aria-busy={busy}>
      <div className={styles.heading}>
        <h3>Menu photo</h3>
        <span>
          {file
            ? 'Ready to upload'
            : changed
              ? 'Unsaved change'
              : imageUrl
                ? 'Saved photo'
                : illustration
                  ? illustration.label
                  : 'Optional'}
        </span>
      </div>
      <div className={styles.preview}>
        {shownImage ? (
          // eslint-disable-next-line @next/next/no-img-element -- Local blob previews and already processed same-origin WebP need no image proxy.
          <img
            src={shownImage}
            alt={
              file
                ? 'Selected photo preview'
                : (illustration?.alt ?? `Menu photo for ${itemName || 'this item'}`)
            }
          />
        ) : (
          <div className={styles.empty}>
            <ImagePlus size={28} aria-hidden="true" />
            <p>
              {changed ? 'Photo will be removed when you save.' : 'Add a clear photo of this item.'}
            </p>
          </div>
        )}
      </div>
      {illustration && (
        <p className={styles.help}>
          Temporary illustration — not a photograph of your serving. Upload the actual item photo to
          replace it.
          {changed && ' Save this item to confirm removal of the previous photo.'}
        </p>
      )}
      <p id={descriptionId} className={styles.help}>
        JPEG, PNG or WebP, up to 5 MB and 16 megapixels. Use a photo you have permission to publish.
        Uploaded photos are public. Replacing or removing a photo from this item does not delete its
        public link.
      </p>
      <label htmlFor={fileId} className={styles.fileLabel}>
        Choose item photo
      </label>
      <input
        ref={input}
        id={fileId}
        type="file"
        accept={MENU_PHOTO_SOURCE_TYPES.join(',')}
        aria-describedby={descriptionId}
        disabled={disabled || busy}
        onChange={(event) => choose(event.target.files?.[0])}
        className={styles.fileInput}
      />
      {file && <p className={styles.filename}>{file.name}</p>}
      <div className={styles.actions}>
        {file && (
          <>
            <button
              type="button"
              className="lc-primary"
              disabled={disabled || busy}
              onClick={() => void upload()}
            >
              {busy ? 'Uploading photo…' : 'Upload photo'}
            </button>
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => {
                clearFile()
                setError('')
                setNotice('')
              }}
            >
              Discard selected photo
            </button>
          </>
        )}
        {imageUrl && (
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => {
              clearFile()
              current.current.onChange(null)
              setError('')
              setNotice('Photo removed from this draft. Save the menu item to confirm.')
            }}
          >
            Remove photo
          </button>
        )}
        {changed && (
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => {
              clearFile()
              current.current.onChange(savedImageUrl)
              setError('')
              setNotice('Saved photo restored in this draft.')
            }}
          >
            Restore saved photo
          </button>
        )}
      </div>
      {file && !error && (
        <p className={styles.help}>Upload this photo or discard it before saving the menu item.</p>
      )}
      {busy && (
        <p role="status" className={styles.help}>
          Uploading and preparing your photo. Keep this screen open.
        </p>
      )}
      {notice && (
        <p role="status" className={styles.success}>
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </section>
  )
}

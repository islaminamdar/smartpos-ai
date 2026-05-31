'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function MenuImportStep({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true)
    try {
      const reader = new FileReader()
      const dataUrl = await new Promise<string>((res, rej) => {
        reader.onload = () => res(reader.result as string)
        reader.onerror = () => rej(reader.error)
        reader.readAsDataURL(file)
      })
      const r = await fetch('/api/ai/import-menu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageDataUrl: dataUrl }),
      })
      if (!r.ok) throw new Error(await r.text())
      onDone()
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-semibold">Upload your menu</h2>
      <p className="text-muted-foreground">
        A photo or PDF works. The AI will read item names and prices.
      </p>
      <Input type="file" accept="image/*,application/pdf" onChange={upload} disabled={busy} />
      {busy && <p>Reading your menu… this takes about 15 seconds.</p>}
      <Button variant="ghost" onClick={onDone}>
        I&apos;ll add items manually instead
      </Button>
    </section>
  )
}

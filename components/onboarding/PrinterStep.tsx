'use client'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function PrinterStep({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const [printers, setPrinters] = useState<{ id: number; name: string }[]>([])
  const [picked, setPicked] = useState<string>('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    fetch('/api/tenant/printers')
      .then((r) => r.json())
      .then((d) => setPrinters(d.printers ?? []))
  }, [])
  async function save() {
    setBusy(true)
    try {
      await fetch('/api/tenant/printers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ printerId: Number(picked) }),
      })
      onDone()
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-semibold">Pick your receipt printer</h2>
      <p className="text-muted-foreground">
        Install the PrintNode agent on the same computer as your printer, then refresh.
      </p>
      <Select value={picked} onValueChange={(v) => setPicked(v ?? '')}>
        <SelectTrigger>
          <SelectValue placeholder="Choose a printer" />
        </SelectTrigger>
        <SelectContent>
          {printers.map((p) => (
            <SelectItem key={p.id} value={String(p.id)}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex gap-2">
        <Button onClick={save} disabled={busy || !picked}>
          Use this printer
        </Button>
        <Button variant="ghost" onClick={onSkip}>
          Skip — I&apos;ll print later
        </Button>
      </div>
    </section>
  )
}

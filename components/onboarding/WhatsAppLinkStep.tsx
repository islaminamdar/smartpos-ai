'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function WhatsAppLinkStep({ onDone, onSkip }: { onDone: () => void; onSkip: () => void }) {
  const [phoneNumberId, setPhoneNumberId] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true)
    try {
      await fetch('/api/tenant/whatsapp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumberId, token }),
      })
      onDone()
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-semibold">Connect your WhatsApp</h2>
      <p className="text-muted-foreground">
        Follow the Meta Cloud API setup steps and paste your Phone Number ID + permanent access
        token below. We&apos;ll start replying to customers automatically.
      </p>
      <div>
        <Label>Phone Number ID</Label>
        <Input value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} />
      </div>
      <div>
        <Label>Permanent Access Token</Label>
        <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <Button onClick={save} disabled={busy || !phoneNumberId || !token}>
          Connect
        </Button>
        <Button variant="ghost" onClick={onSkip}>
          Skip for now
        </Button>
      </div>
    </section>
  )
}

'use client'
import { Button } from '@/components/ui/button'

export default function BillingPage() {
  async function go() {
    const r = await fetch('/api/billing/checkout', { method: 'POST' })
    const { url } = await r.json()
    location.href = url
  }
  return (
    <main className="mx-auto max-w-xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Subscription</h1>
      <p className="text-muted-foreground">Starter — 100 AED / month. 14-day free trial.</p>
      <Button onClick={go} size="lg">
        Subscribe — 100 AED / month
      </Button>
    </main>
  )
}

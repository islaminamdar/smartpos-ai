'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ChatPanel() {
  const [messages, setMessages] = useState<{ role: 'user' | 'ai'; text: string }[]>([])
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)

  async function ask() {
    if (!q.trim()) return
    setMessages((m) => [...m, { role: 'user', text: q }])
    setBusy(true)
    const question = q
    setQ('')
    try {
      const r = await fetch('/api/ai/dashboard-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      })
      const json = await r.json()
      setMessages((m) => [...m, { role: 'ai', text: json.answer }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-2xl border bg-gradient-to-br from-violet-50/50 to-cyan-50/50 p-6 dark:from-violet-950/30 dark:to-cyan-950/30">
      <h2 className="text-lg font-semibold">Ask anything about your restaurant</h2>
      <div className="flex max-h-96 min-h-32 flex-col gap-3 overflow-auto">
        {messages.length === 0 && (
          <div className="space-y-1 text-sm text-muted-foreground">
            <p>Try:</p>
            <p>• &quot;How did yesterday compare to last Friday?&quot;</p>
            <p>• &quot;What sold the most this week?&quot;</p>
            <p>• &quot;Any complaints today?&quot;</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={
              m.role === 'user'
                ? 'self-end rounded-2xl bg-violet-600 px-4 py-2 text-white'
                : 'self-start rounded-2xl bg-white px-4 py-2 shadow dark:bg-neutral-900'
            }
          >
            {m.text}
          </div>
        ))}
        {busy && <div className="self-start text-sm text-muted-foreground">Thinking…</div>}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          ask()
        }}
        className="flex gap-2"
      >
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Type a question…"
          disabled={busy}
        />
        <Button type="submit" disabled={busy || !q.trim()}>
          Ask
        </Button>
      </form>
    </div>
  )
}

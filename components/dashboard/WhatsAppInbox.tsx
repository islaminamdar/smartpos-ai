'use client'
import { useEffect, useState } from 'react'
import { createBrowser } from '@/lib/db/supabase'
import { Button } from '@/components/ui/button'

type Conv = {
  id: string
  customer_name: string | null
  external_id: string
  ai_active: boolean
  last: string
}

export function WhatsAppInbox() {
  const [convs, setConvs] = useState<Conv[]>([])

  async function load() {
    const sb = createBrowser()
    const { data } = await sb
      .from('conversations')
      .select('id, customer_name, external_id, ai_active, messages(body, created_at)')
      .eq('channel', 'whatsapp')
      .order('created_at', { ascending: false })
      .limit(50)
    setConvs(
      ((data ?? []) as any[]).map((c: any) => ({
        id: c.id,
        customer_name: c.customer_name,
        external_id: c.external_id,
        ai_active: c.ai_active,
        last: c.messages?.at(-1)?.body ?? '',
      }))
    )
  }

  useEffect(() => {
    load()
  }, [])

  async function toggle(c: Conv) {
    const sb = createBrowser()
    await sb.from('conversations').update({ ai_active: !c.ai_active }).eq('id', c.id)
    load()
  }

  return (
    <div className="space-y-2">
      {convs.map((c) => (
        <div key={c.id} className="flex items-center justify-between rounded-xl border p-3">
          <div>
            <div className="font-medium">{c.customer_name ?? c.external_id}</div>
            <div className="text-sm text-muted-foreground">{c.last}</div>
          </div>
          <Button variant={c.ai_active ? 'outline' : 'default'} onClick={() => toggle(c)}>
            {c.ai_active ? 'Take over' : 'Let AI handle'}
          </Button>
        </div>
      ))}
      {convs.length === 0 && (
        <p className="text-center text-muted-foreground">No WhatsApp conversations yet.</p>
      )}
    </div>
  )
}

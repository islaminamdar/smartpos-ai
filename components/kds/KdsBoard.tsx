'use client'
import { useEffect, useState } from 'react'
import { createBrowser } from '@/lib/db/supabase'
import { subscribeOrders, type OrderRow } from '@/lib/realtime/orderChannel'
import { TicketCard } from './TicketCard'

export function KdsBoard({ tenantId }: { tenantId: string }) {
  const [orders, setOrders] = useState<OrderRow[]>([])

  async function load() {
    const sb = createBrowser()
    const { data } = await sb
      .from('orders')
      .select(
        'id, status, table_label, total_aed, created_at, order_items(name_snapshot, qty, modifiers_snapshot)',
      )
      .in('status', ['new', 'accepted', 'preparing', 'ready'])
      .order('created_at', { ascending: true })
    setOrders(
      ((data ?? []) as any[]).map((o: any) => ({
        id: o.id,
        status: o.status,
        table_label: o.table_label,
        total_aed: Number(o.total_aed ?? 0),
        created_at: o.created_at,
        items: (o.order_items ?? []) as any[],
      })),
    )
  }

  useEffect(() => {
    load()
    const ch = subscribeOrders(tenantId, load)
    return () => {
      ch.unsubscribe()
    }
  }, [tenantId])

  async function advance(id: string, status: string) {
    const sb = createBrowser()
    await sb
      .from('orders')
      .update({ status: status as any })
      .eq('id', id)
  }

  return (
    <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {orders.map((o) => (
        <TicketCard key={o.id} order={o} onAdvance={(s) => advance(o.id, s)} />
      ))}
      {orders.length === 0 && (
        <p className="col-span-full text-center text-lg text-muted-foreground">
          No tickets — try sending a voice order.
        </p>
      )}
    </div>
  )
}

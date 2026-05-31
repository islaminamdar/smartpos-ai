import { createBrowser } from '@/lib/db/supabase'
import type { RealtimeChannel } from '@supabase/supabase-js'

export type OrderRow = {
  id: string
  status: string
  table_label: string | null
  total_aed: number
  created_at: string
  items: { name_snapshot: string; qty: number; modifiers_snapshot: any[] }[]
}

export function subscribeOrders(tenantId: string, onChange: () => void): RealtimeChannel {
  const sb = createBrowser()
  return sb
    .channel(`orders:${tenantId}`)
    .on(
      'postgres_changes' as any,
      {
        event: '*',
        schema: 'public',
        table: 'orders',
        filter: `tenant_id=eq.${tenantId}`,
      },
      () => onChange(),
    )
    .on(
      'postgres_changes' as any,
      { event: '*', schema: 'public', table: 'order_items' },
      () => onChange(),
    )
    .subscribe()
}

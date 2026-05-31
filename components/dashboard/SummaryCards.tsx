import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { createServer } from '@/lib/db/supabase'

export async function SummaryCards({ tenantId }: { tenantId: string }) {
  const sb = await createServer()
  const today_iso = new Date().toISOString().slice(0, 10)
  let todayOrders = 0
  let todayRevenue = 0
  let top: { item: string; qty: number }[] = []
  try {
    const { data: today } = await (sb as any)
      .from('v_orders_summary')
      .select('orders, revenue')
      .eq('tenant_id', tenantId)
      .eq('day', today_iso)
      .maybeSingle()
    if (today) {
      todayOrders = Number(today.orders ?? 0)
      todayRevenue = Number(today.revenue ?? 0)
    }
    const { data: t } = await (sb as any)
      .from('v_top_items')
      .select('item, qty')
      .eq('tenant_id', tenantId)
      .order('qty', { ascending: false })
      .limit(3)
    top = (t ?? []).map((r: any) => ({ item: r.item, qty: Number(r.qty) }))
  } catch {
    // views may not exist yet in dev — soft empty
  }
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle>Today&apos;s orders</CardTitle>
        </CardHeader>
        <CardContent className="text-3xl font-semibold">{todayOrders}</CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Today&apos;s revenue</CardTitle>
        </CardHeader>
        <CardContent className="text-3xl font-semibold">AED {todayRevenue.toFixed(2)}</CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Best sellers</CardTitle>
        </CardHeader>
        <CardContent>
          {top.length === 0 ? (
            <span className="text-sm text-muted-foreground">No sales yet</span>
          ) : (
            top.map((r) => (
              <div key={r.item}>
                {r.qty}× {r.item}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}

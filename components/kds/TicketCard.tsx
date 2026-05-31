import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatDistanceToNow } from 'date-fns'
import type { OrderRow } from '@/lib/realtime/orderChannel'

const NEXT: Record<string, string | null> = {
  new: 'preparing',
  preparing: 'ready',
  ready: 'served',
  served: null,
  cancelled: null,
  accepted: 'preparing',
}

export function TicketCard({
  order,
  onAdvance,
}: {
  order: OrderRow
  onAdvance: (next: string) => void
}) {
  const next = NEXT[order.status] ?? null

  return (
    <Card className="border-2">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          {order.table_label && <Badge>{order.table_label}</Badge>}
          <span>#{order.id.slice(0, 4)}</span>
        </CardTitle>
        <span className="text-sm text-muted-foreground">
          {formatDistanceToNow(new Date(order.created_at))} ago
        </span>
      </CardHeader>
      <CardContent className="space-y-1 text-lg">
        {order.items.map((it, i) => (
          <div key={i}>
            <span className="font-semibold">{it.qty}×</span> {it.name_snapshot}
            {it.modifiers_snapshot.length > 0 && (
              <div className="ml-6 text-sm text-muted-foreground">
                {it.modifiers_snapshot.map((m: any) => `${m.name}: ${m.value}`).join(', ')}
              </div>
            )}
          </div>
        ))}
      </CardContent>
      <CardFooter>{next && <Button onClick={() => onAdvance(next)}>Mark {next}</Button>}</CardFooter>
    </Card>
  )
}

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

export function OrderCart({ parsed }: { parsed: any | null }) {
  if (!parsed) {
    return (
      <Card>
        <CardContent className="p-6 text-muted-foreground">
          No order yet. Tap the mic.
        </CardContent>
      </Card>
    )
  }

  if (parsed.clarification_needed) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="font-medium">Need clarification:</p>
          <p>{parsed.clarification_needed}</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Order parsed <Badge variant="secondary">{Math.round(parsed.confidence * 100)}%</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {parsed.items.map((it: any, i: number) => (
          <div key={i} className="flex items-center justify-between">
            <span>
              {it.qty} × {it.name_snapshot ?? it.menu_item_id}
            </span>
            <span className="text-sm text-muted-foreground">
              {it.modifiers?.map((m: any) => `${m.name}: ${m.value}`).join(', ')}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

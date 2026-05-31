const ESC = '\x1b',
  GS = '\x1d'
const ALIGN_CENTER = `${ESC}a1`,
  ALIGN_LEFT = `${ESC}a0`
const BOLD_ON = `${ESC}E1`,
  BOLD_OFF = `${ESC}E0`
const SIZE_DOUBLE = `${GS}!\x11`,
  SIZE_NORMAL = `${GS}!\x00`
const CUT = `${GS}V0`

export type TicketInput = {
  tenantName: string
  orderId: string
  tableLabel?: string | null
  items: {
    name: string
    qty: number
    price_aed: number
    modifiers: { name: string; value: string }[]
  }[]
  total_aed: number
  createdAt: Date
}

export function formatTicket(t: TicketInput): string {
  const lines: string[] = []
  lines.push(ALIGN_CENTER + BOLD_ON + SIZE_DOUBLE + t.tenantName + SIZE_NORMAL + BOLD_OFF)
  lines.push(t.createdAt.toISOString().slice(0, 16).replace('T', ' '))
  if (t.tableLabel) lines.push(BOLD_ON + 'Table ' + t.tableLabel + BOLD_OFF)
  lines.push('Order #' + t.orderId.slice(0, 6))
  lines.push(ALIGN_LEFT + '-'.repeat(32))
  for (const it of t.items) {
    lines.push(
      BOLD_ON +
        `${it.qty} x ${it.name}` +
        BOLD_OFF +
        '  ' +
        `AED ${(it.qty * it.price_aed).toFixed(2)}`
    )
    for (const m of it.modifiers) lines.push('  - ' + m.name + ': ' + m.value)
  }
  lines.push('-'.repeat(32))
  lines.push(ALIGN_CENTER + BOLD_ON + `TOTAL AED ${t.total_aed.toFixed(2)}` + BOLD_OFF)
  lines.push('\n\n\n')
  lines.push(CUT)
  return lines.join('\n')
}

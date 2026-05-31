import { createServer } from './supabase'
import type { MenuItem } from '@/lib/ai/parseOrder'

export async function getTenantMenu(tenantId: string): Promise<MenuItem[]> {
  const sb = await createServer()

  // Fetch menu_items first
  const { data: items } = await sb
    .from('menu_items')
    .select('id, name, aliases, price_aed')
    .eq('tenant_id', tenantId)
    .eq('active', true)

  if (!items || items.length === 0) return []

  const itemIds = items.map(i => i.id)

  // Fetch modifiers for these items
  const { data: modifiers } = await sb
    .from('menu_modifiers')
    .select('item_id, name, options')
    .in('item_id', itemIds)

  const modsByItemId = new Map<string, { name: string; options: string[] }[]>()
  for (const mod of modifiers ?? []) {
    const opts = (mod.options as any[]).map((o: any) => (typeof o === 'string' ? o : o.name ?? String(o)))
    const existing = modsByItemId.get(mod.item_id) ?? []
    existing.push({ name: mod.name, options: opts })
    modsByItemId.set(mod.item_id, existing)
  }

  return items.map(r => ({
    id: r.id,
    name: r.name,
    aliases: r.aliases ?? [],
    price_aed: Number(r.price_aed),
    modifiers: modsByItemId.get(r.id) ?? [],
  }))
}

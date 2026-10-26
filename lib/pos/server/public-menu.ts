import 'server-only'

import { temporaryMenuIllustration } from '@/lib/pos/menu-illustrations'

import { activeCounterPortal } from './counter-portal'
import { PosServerError, posClient } from './client'

export type PublicMenuItem = {
  id: string
  name: string
  category: string
  imageUrl: string | null
  imageAlt: string
  imageLabel: 'Temporary illustration' | null
  unit: 'piece' | 'pack' | 'kg'
  unitPriceFils: number
}

export type PublicMenu = {
  slug: string
  displayName: string
  items: PublicMenuItem[]
}

/**
 * The QR menu deliberately uses only a portal's active, sellable catalogue.
 * It is display-only: no staff records, device identifiers, order endpoints,
 * prices from a client payload, or payment controls are exposed.
 */
export async function activePublicMenu(slug: string): Promise<PublicMenu | null> {
  const portal = await activeCounterPortal(slug)
  if (!portal) return null

  const { data, error } = await posClient(undefined, true)
    .from('pos_products')
    .select('id,name,category,image_url,unit,unit_price_fils')
    .eq('organization_id', portal.organizationId)
    .eq('branch_id', portal.branchId)
    .eq('active', true)
    .gt('unit_price_fils', 0)
    .order('category', { ascending: true })
    .order('name', { ascending: true })
    .limit(1000)

  if (error) throw new PosServerError('public_menu_unavailable', 503)
  const items = (data ?? []).flatMap((product) => {
    if (
      typeof product.id !== 'string' ||
      typeof product.name !== 'string' ||
      typeof product.category !== 'string' ||
      !['piece', 'pack', 'kg'].includes(String(product.unit)) ||
      !Number.isSafeInteger(product.unit_price_fils) ||
      product.unit_price_fils <= 0
    ) {
      return []
    }
    const illustration = temporaryMenuIllustration({
      id: product.id,
      branchId: portal.branchId,
      imageUrl: product.image_url,
    })
    const imageUrl = product.image_url ?? illustration?.src ?? null
    return [
      {
        id: product.id,
        name: product.name.trim(),
        category: product.category.trim(),
        imageUrl,
        imageAlt: illustration?.alt ?? product.name.trim(),
        imageLabel: illustration?.label ?? null,
        unit: product.unit as PublicMenuItem['unit'],
        unitPriceFils: product.unit_price_fils,
      },
    ]
  })

  return { slug: portal.slug, displayName: portal.displayName, items }
}

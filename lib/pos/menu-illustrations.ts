/** Approved display-only fallbacks for eight specific Bur Dubai catalogue records.
 * Never persist these as source photographs or infer a match from a product name. */
const branchId = '79d4b844-1fd4-4cdf-a32f-db9329d75f3a'
const illustrations: Readonly<Record<string, { asset: string; description: string }>> = {
  'dc0f1421-33f2-55a5-bf17-eee5d3236d7c': {
    asset: 'samosa-pav',
    description: 'Samosa in a pav bun',
  },
  '1173eed3-edfc-5a34-b175-0b7195bc4ddc': { asset: 'vada-pav', description: 'Vada in a pav bun' },
  '2268550f-c55a-554e-aca9-98e7d028f527': {
    asset: 'matka-lassi',
    description: 'Lassi in a clay pot',
  },
  '86d5608e-ee87-58c4-9672-452e7978aea9': {
    asset: 'matka-lassi',
    description: 'Lassi in a clay pot',
  },
  '664ee15d-c27f-5245-8eb8-05cd51219c7d': { asset: 'toast', description: 'Golden toast slices' },
  '8d2bd971-1143-59ac-a7d6-d05229767839': {
    asset: 'kismis-aflatoon',
    description: 'Generic raisin sweets',
  },
  '8c6e9ad1-7f2a-52b2-9fb5-c9511ede345d': {
    asset: 'bakery-placeholder',
    description: 'Generic bakery basket; Maska butter appearance awaiting confirmation',
  },
  '41c1e2ae-ceb8-565d-b658-b4e0303e4a8f': {
    asset: 'meal-placeholder',
    description: 'Covered serving dish; meal contents awaiting confirmation',
  },
}

export function temporaryMenuIllustration(item: {
  id?: string
  branchId: string
  imageUrl: string | null
}): { src: string; alt: string; label: 'Temporary illustration' } | null {
  if (item.imageUrl || item.branchId !== branchId || !item.id) return null
  const illustration = Object.hasOwn(illustrations, item.id) ? illustrations[item.id] : null
  if (!illustration) return null
  return {
    src: `/pos-assets/menu-illustrations/${illustration.asset}.webp`,
    alt: `Temporary illustration: ${illustration.description}. Not a photograph of the restaurant's serving.`,
    label: 'Temporary illustration',
  }
}

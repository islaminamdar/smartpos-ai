import { describe, expect, it } from 'vitest'
import { temporaryMenuIllustration } from '@/lib/pos/menu-illustrations'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import sharp from 'sharp'

const branchId = '79d4b844-1fd4-4cdf-a32f-db9329d75f3a'
const mappings = [
  ['dc0f1421-33f2-55a5-bf17-eee5d3236d7c', 'samosa-pav'],
  ['1173eed3-edfc-5a34-b175-0b7195bc4ddc', 'vada-pav'],
  ['2268550f-c55a-554e-aca9-98e7d028f527', 'matka-lassi'],
  ['86d5608e-ee87-58c4-9672-452e7978aea9', 'matka-lassi'],
  ['664ee15d-c27f-5245-8eb8-05cd51219c7d', 'toast'],
  ['8d2bd971-1143-59ac-a7d6-d05229767839', 'kismis-aflatoon'],
  ['8c6e9ad1-7f2a-52b2-9fb5-c9511ede345d', 'bakery-placeholder'],
  ['41c1e2ae-ceb8-565d-b658-b4e0303e4a8f', 'meal-placeholder'],
]

describe('approved temporary menu illustrations', () => {
  it.each(mappings)('matches exact product %s without changing the catalogue', (id, asset) => {
    const product = Object.freeze({ id, branchId, imageUrl: null, active: false, unitPriceFils: 0 })
    const result = temporaryMenuIllustration(product)
    expect(result?.src).toBe(`/pos-assets/menu-illustrations/${asset}.webp`)
    expect(result?.label).toBe('Temporary illustration')
    expect(result?.alt).toContain('Not a photograph')
    expect(product).toEqual({ id, branchId, imageUrl: null, active: false, unitPriceFils: 0 })
  })
  it('always leaves existing photographs in control', () => {
    for (const [id] of mappings) {
      expect(
        temporaryMenuIllustration({ id, branchId, imageUrl: '/pos-assets/menu/upload_new.webp' })
      ).toBeNull()
      expect(
        temporaryMenuIllustration({ id, branchId, imageUrl: '/pos-assets/menu/archived.webp' })
      ).toBeNull()
    }
  })
  it('does not infer illustrations from names, another branch or object prototype keys', () => {
    for (const id of [undefined, 'toString', '__proto__', 'SAMOSA PAV', 'unknown']) {
      expect(temporaryMenuIllustration({ id, branchId, imageUrl: null })).toBeNull()
    }
    for (const [id] of mappings)
      expect(
        temporaryMenuIllustration({ id, branchId: 'another-branch', imageUrl: null })
      ).toBeNull()
  })
  it('uses generic imagery where the actual product identity remains unconfirmed', () => {
    for (const id of [
      '8c6e9ad1-7f2a-52b2-9fb5-c9511ede345d',
      '41c1e2ae-ceb8-565d-b658-b4e0303e4a8f',
    ]) {
      expect(temporaryMenuIllustration({ id, branchId, imageUrl: null })?.alt).toContain(
        'awaiting confirmation'
      )
    }
  })
  it('ships seven small decodable assets matching their provenance hashes', async () => {
    const provenance = JSON.parse(
      readFileSync('public/pos-assets/menu-illustrations/provenance.json', 'utf8')
    )
    expect(provenance.assets).toHaveLength(7)
    for (const asset of provenance.assets) {
      const bytes = readFileSync(asset.asset)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256)
      expect(bytes.length).toBeLessThan(50000)
      const metadata = await sharp(bytes).metadata()
      expect(metadata.format).toBe('webp')
      expect([metadata.width, metadata.height]).toEqual([512, 512])
    }
  })
})

it('serves the actual illustration paths through the hosted release without allowing writes', async () => {
  const { publicReleaseAccess } = await import('@/lib/pos/public-release')
  for (const [, name] of mappings) {
    const path = `/pos-assets/menu-illustrations/${name}.webp`
    expect(publicReleaseAccess(path, 'GET', true)).toBe('allow')
    expect(publicReleaseAccess(path, 'POST', true)).toBe('not_found')
  }
  expect(publicReleaseAccess('/menu/illustrations/samosa-pav.webp', 'GET', true)).toBe('not_found')
})

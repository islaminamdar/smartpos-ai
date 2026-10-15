import { readFile, access } from 'node:fs/promises'
import { resolve } from 'node:path'

// Accept an isolated fixture directory so failure behavior can be verified without
// changing the working website. This checks source integrity, not runtime safety.
const root = resolve(process.argv[2] || new URL('..', import.meta.url).pathname)
const read = (path) => readFile(resolve(root, path), 'utf8')
const marketing = await read('app/(marketing)/page.tsx')
const banned = ['AI handles 80%', 'Start 14-day free trial']
for (const text of banned) {
  if (marketing.includes(text)) throw new Error(`Unsupported marketing claim: ${text}`)
}
const catalogue = JSON.parse(await read('data/pos/mithaiwala-catalogue.json'))
if (catalogue.items.length !== 133)
  throw new Error('Archived catalogue count changed without source review')
const ids = new Set()
for (const item of catalogue.items) {
  if (ids.has(item.id)) throw new Error(`Duplicate source ID: ${item.id}`)
  ids.add(item.id)
  if (!Number.isSafeInteger(item.priceFils) || item.priceFils < 0)
    throw new Error('Invalid catalogue money')
  if (item.image) {
    if (
      !/^\/pos-assets\/menu\/[A-Za-z0-9]+\.webp$/.test(item.image) ||
      !/^[a-f0-9]{64}$/.test(item.sourceImageSha256 || '')
    )
      throw new Error('Missing source image provenance')
    await access(resolve(root, 'public' + item.image))
  }
}
const assets = JSON.parse(await read('public/pos-assets/offline-assets.json'))
for (const asset of assets) {
  if (!asset.startsWith('/pos-assets/') || asset.includes('..'))
    throw new Error('Invalid offline asset path')
  await access(resolve(root, 'public' + asset))
}
console.log(
  `POS build gate passed: ${ids.size} source IDs, ${assets.length} offline assets, truthful marketing claims.`
)

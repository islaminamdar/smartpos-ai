import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import QRCode from 'qrcode'

import { PublicMenuClient } from '@/components/public-menu/PublicMenuClient'
import { activePublicMenu } from '@/lib/pos/server/public-menu'

export const dynamic = 'force-dynamic'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ portal: string }>
}): Promise<Metadata> {
  const { portal } = await params
  const menu = await activePublicMenu(portal)
  if (!menu) return { title: 'Menu unavailable', robots: { index: false, follow: false } }
  return {
    title: `Menu · ${menu.displayName}`,
    description: `Current menu and prices for ${menu.displayName}.`,
    robots: { index: false, follow: false },
  }
}

export default async function PublicMenuPage({ params }: { params: Promise<{ portal: string }> }) {
  const { portal } = await params
  const menu = await activePublicMenu(portal)
  if (!menu) notFound()
  const menuUrl = `https://pos.internext.info/menu/${encodeURIComponent(menu.slug)}`
  const qrDataUrl = await QRCode.toDataURL(menuUrl, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 560,
    color: { dark: '#5f1518', light: '#fffdf8' },
  })
  return <PublicMenuClient menu={menu} qrDataUrl={qrDataUrl} menuUrl={menuUrl} />
}

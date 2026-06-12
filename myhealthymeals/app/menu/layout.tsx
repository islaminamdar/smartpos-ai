import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Menu',
  description:
    'Browse our dietitian-designed menu. Indian and international meals with full macro and allergen info.',
}

export default function MenuLayout({ children }: { children: React.ReactNode }) {
  return children
}

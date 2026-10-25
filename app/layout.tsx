import './globals.css'
import type { Metadata } from 'next'
import BrowserCompatibility from './BrowserCompatibility'

export const metadata: Metadata = {
  metadataBase: new URL('https://pos.internext.info'),
  title: 'Internext POS · Point of sale for restaurants and retail',
  description:
    'POS software for restaurants, grocery stores, pet shops and retail counters. Sales, stock, receipts and shifts for US$100 per branch per month.',
  icons: { icon: '/pos-icon.svg' },
  openGraph: {
    title: 'Internext POS · Your counter, in order',
    description: 'Explore the POS training preview for restaurants and retail. US$100 per branch per month.',
    type: 'website',
    images: [
      {
        url: '/pos-share.png',
        width: 1200,
        height: 630,
        alt: 'Internext POS — sales and stock workspace',
      },
    ],
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        <BrowserCompatibility />
        {children}
      </body>
    </html>
  )
}

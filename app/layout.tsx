import './globals.css'
import type { Metadata } from 'next'
import BrowserCompatibility from './BrowserCompatibility'

export const metadata: Metadata = {
  metadataBase: new URL('https://pos.internext.info'),
  title: 'Internext POS · Your restaurant, in order',
  description:
    'Restaurant POS for ordering, shifts and branches. AED 100 per branch per month, all features included.',
  icons: { icon: '/pos-icon.svg' },
  openGraph: {
    title: 'Internext POS · Your restaurant, in order',
    description: 'Explore the restaurant POS training preview. AED 100 per branch per month.',
    type: 'website',
    images: [
      {
        url: '/pos-share.png',
        width: 1200,
        height: 630,
        alt: 'Internext POS — restaurant workspace',
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

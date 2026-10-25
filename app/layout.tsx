import './globals.css'
import type { Metadata } from 'next'
import BrowserCompatibility from './BrowserCompatibility'

export const metadata: Metadata = {
  metadataBase: new URL('https://pos.internext.info'),
  title: {
    default: 'Restaurant POS Dubai | Retail POS Demos | Internext',
    template: '%s | Internext POS',
  },
  description:
    'Online restaurant POS software in Dubai, with configured retail demos. Sales, stock, receipt details and shifts for US$100 per branch per month.',
  applicationName: 'Internext POS',
  authors: [{ name: 'Internext Information Technology', url: 'https://internext.info/' }],
  creator: 'Internext Information Technology',
  publisher: 'Internext Information Technology',
  keywords: [
    'POS software Dubai',
    'restaurant POS Dubai',
    'retail POS UAE',
    'point of sale software Dubai',
    'grocery POS Dubai',
    'cloud POS UAE',
  ],
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  icons: { icon: '/pos-icon.svg' },
  other: { 'geo.region': 'AE-DU', 'geo.placename': 'Dubai' },
  openGraph: {
    title: 'Restaurant POS Dubai & Configured Retail Demos | Internext',
    description:
      'Explore online restaurant POS software and configured retail demos in Dubai, with sales, stock, receipt details and shift control.',
    url: 'https://pos.internext.info/',
    siteName: 'Internext POS',
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
  twitter: {
    card: 'summary_large_image',
    title: 'Restaurant POS Dubai | Internext',
    description:
      'Online restaurant POS with configured retail demos in Dubai, from sales to shift closing.',
    images: ['/pos-share.png'],
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

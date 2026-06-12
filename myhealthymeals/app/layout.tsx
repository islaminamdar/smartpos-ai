import type { Metadata } from 'next'
import { Plus_Jakarta_Sans } from 'next/font/google'
import { Header } from '@/components/layout/header'
import { Footer } from '@/components/layout/footer'
import { PromoBanner } from '@/components/layout/promo-banner'
import { MobileCTA } from '@/components/layout/mobile-cta'
import './globals.css'

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-jakarta',
  display: 'swap',
})

export const metadata: Metadata = {
  title: {
    default: 'MyHealthyMeals — Healthy Meal Delivery Dubai',
    template: '%s | MyHealthyMeals',
  },
  description:
    'Dietitian-portioned, halal-certified healthy meals from AED 22/meal. Fresh-cooked in Business Bay, delivered to Business Bay, DIFC, Downtown, Marina & JLT.',
  metadataBase: new URL('https://myhealthymeals.ae'),
  icons: {
    icon: '/favicon.svg',
  },
  openGraph: {
    title: 'MyHealthyMeals — Healthy Meal Delivery Dubai',
    description:
      "Dubai's healthiest meals. Dietitian-portioned, halal certified, from AED 22/meal. First day on us.",
    url: 'https://myhealthymeals.ae',
    siteName: 'MyHealthyMeals',
    locale: 'en_AE',
    type: 'website',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className={`${jakarta.variable} font-sans`}>
        <PromoBanner />
        <Header />
        <main className="min-h-screen pb-20 lg:pb-0">{children}</main>
        <Footer />
        <MobileCTA />
      </body>
    </html>
  )
}

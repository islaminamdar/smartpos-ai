import type { Metadata } from 'next'
import { Plus_Jakarta_Sans } from 'next/font/google'
import { Header } from '@/components/mhm/layout/header'
import { Footer } from '@/components/mhm/layout/footer'
import { PromoBanner } from '@/components/mhm/layout/promo-banner'
import { MobileCTA } from '@/components/mhm/layout/mobile-cta'

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
  icons: {
    icon: '/mhm-favicon.svg',
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

export default function MealsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${jakarta.variable} font-jakarta`}>
      <PromoBanner />
      <Header />
      <main className="min-h-screen bg-white pb-20 text-surface-900 lg:pb-0">{children}</main>
      <Footer />
      <MobileCTA />
    </div>
  )
}

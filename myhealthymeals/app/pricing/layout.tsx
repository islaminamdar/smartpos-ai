import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'Healthy meal subscription pricing from AED 22/meal. Basic, Standard and Premium plans with free delivery in 5 Dubai zones.',
}

export default function PricingLayout({ children }: { children: React.ReactNode }) {
  return children
}

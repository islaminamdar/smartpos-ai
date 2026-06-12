import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Meal Plans',
  description:
    'Eight dietitian-built meal plans from AED 22/meal. Weight loss, high protein, diabetic-friendly, family, corporate and more.',
}

export default function PlansLayout({ children }: { children: React.ReactNode }) {
  return children
}

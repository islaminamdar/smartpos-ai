import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import LiveCounter from '@/components/pos/LiveCounter'
import { activeCounterPortal } from '@/lib/pos/server/counter-portal'
import '../counter/counter.css'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { robots: { index: false, follow: false } }

export default async function CounterPortalPage({ params }: { params: Promise<{ portal: string }> }) {
  const { portal: slug } = await params
  const portal = await activeCounterPortal(slug)
  if (!portal) notFound()
  return (
    <LiveCounter
      portal={portal}
      offlinePaymentReviewEnabled={process.env.POS_OFFLINE_PAYMENT_REVIEW_ENABLED === 'true'}
      kitchenStationsEnabled={process.env.POS_KITCHEN_STATIONS_ENABLED === 'true'}
    />
  )
}

import type { Metadata } from 'next'
import LiveCounter from '@/components/pos/LiveCounter'
import './counter.css'

export const metadata: Metadata = {
  title: 'Staff counter · Internext POS',
  robots: { index: false, follow: false },
}
export const dynamic = 'force-dynamic'
export default function CounterPage() {
  return (
    <LiveCounter
      offlinePaymentReviewEnabled={process.env.POS_OFFLINE_PAYMENT_REVIEW_ENABLED === 'true'}
      kitchenStationsEnabled={process.env.POS_KITCHEN_STATIONS_ENABLED === 'true'}
    />
  )
}

import type { Metadata } from 'next'
import LiveCounter from '@/components/pos/LiveCounter'
import './counter.css'

export const metadata: Metadata = {
  title: 'Staff counter · Internext POS',
  robots: { index: false, follow: false },
}
export const dynamic = 'force-dynamic'
export default function CounterPage() {
  return <LiveCounter />
}

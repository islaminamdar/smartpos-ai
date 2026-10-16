import type { Metadata } from 'next'
import StaffInvitation from '@/components/pos/staff/StaffInvitation'

export const metadata: Metadata = {
  title: 'Accept staff invitation · Internext POS',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}
export const dynamic = 'force-dynamic'
export default function StaffAcceptPage() {
  return <StaffInvitation />
}

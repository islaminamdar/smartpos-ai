import BillingClient from './BillingClient'
import './billing.css'
export const metadata = {
  title: 'Branch subscriptions | Internext POS',
  robots: { index: false, follow: false },
}
export default function BillingPage() {
  return <BillingClient />
}

import { WhatsAppInbox } from '@/components/dashboard/WhatsAppInbox'

export default function WhatsAppPage() {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="mb-6 text-2xl font-semibold">WhatsApp conversations</h1>
      <WhatsAppInbox />
    </main>
  )
}

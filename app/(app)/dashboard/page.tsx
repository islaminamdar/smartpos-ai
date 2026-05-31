import { requireSession } from '@/lib/auth/session'
import { SummaryCards } from '@/components/dashboard/SummaryCards'
import { ChatPanel } from '@/components/dashboard/ChatPanel'

export default async function DashboardPage() {
  const s = await requireSession()
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 p-6">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Hi 👋</h1>
      </header>
      <SummaryCards tenantId={s.tenantId} />
      <ChatPanel />
    </main>
  )
}

import Link from 'next/link'
import { requireSession } from '@/lib/auth/session'
import { logout } from '@/app/(auth)/actions'
import { Mic, MonitorSpeaker, MessageSquare, LayoutDashboard, Settings } from 'lucide-react'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireSession()
  return (
    <div className="grid min-h-screen grid-cols-[14rem_1fr]">
      <aside className="relative border-r bg-white/60 p-4 backdrop-blur dark:bg-neutral-950/60">
        <Link href="/dashboard" className="mb-8 block text-xl font-semibold tracking-tight">
          SmartPOS<span className="text-violet-600">.ai</span>
        </Link>
        <nav className="flex flex-col gap-1 text-sm">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 rounded-lg p-2 hover:bg-violet-50 dark:hover:bg-violet-950/30"
          >
            <LayoutDashboard className="h-4 w-4" />
            Dashboard
          </Link>
          <Link
            href="/order"
            className="flex items-center gap-2 rounded-lg p-2 hover:bg-violet-50 dark:hover:bg-violet-950/30"
          >
            <Mic className="h-4 w-4" />
            Voice Order
          </Link>
          <Link
            href="/kds"
            className="flex items-center gap-2 rounded-lg p-2 hover:bg-violet-50 dark:hover:bg-violet-950/30"
          >
            <MonitorSpeaker className="h-4 w-4" />
            Kitchen
          </Link>
          <Link
            href="/dashboard/whatsapp"
            className="flex items-center gap-2 rounded-lg p-2 hover:bg-violet-50 dark:hover:bg-violet-950/30"
          >
            <MessageSquare className="h-4 w-4" />
            WhatsApp
          </Link>
          <Link
            href="/dashboard/settings/billing"
            className="flex items-center gap-2 rounded-lg p-2 hover:bg-violet-50 dark:hover:bg-violet-950/30"
          >
            <Settings className="h-4 w-4" />
            Settings
          </Link>
        </nav>
        <form action={logout} className="absolute bottom-4 left-4">
          <button className="text-xs text-muted-foreground">Sign out</button>
        </form>
      </aside>
      <div>{children}</div>
    </div>
  )
}

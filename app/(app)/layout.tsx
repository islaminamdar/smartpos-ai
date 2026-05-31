import { requireSession } from '@/lib/auth/session'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireSession()
  return <>{children}</>
}

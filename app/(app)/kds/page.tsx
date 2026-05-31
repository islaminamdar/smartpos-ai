import { requireSession } from '@/lib/auth/session'
import { KdsBoard } from '@/components/kds/KdsBoard'

export default async function KdsPage() {
  const s = await requireSession()
  return <KdsBoard tenantId={s.tenantId} />
}

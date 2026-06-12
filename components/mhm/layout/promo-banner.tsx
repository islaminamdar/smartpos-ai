import Link from 'next/link'
import { ArrowRight } from 'lucide-react'

export function PromoBanner() {
  return (
    <div className="bg-brand-600 text-white">
      <div className="container-main flex items-center justify-center gap-2 py-2.5 text-center text-xs font-medium sm:text-sm">
        <span>Start any plan — your first day&apos;s on us this month.</span>
        <Link
          href="/quiz"
          className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-brand-100"
        >
          Claim
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  )
}

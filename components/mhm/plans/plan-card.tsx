import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import type { Plan } from '@/lib/mhm/plans'

export function PlanCard({ plan }: { plan: Plan }) {
  return (
    <article id={plan.id} className="card-hover scroll-mt-24">
      <div className="flex items-start justify-between gap-3">
        <span className="text-3xl">{plan.emoji}</span>
        <div className="text-right">
          <p className="text-xs font-medium text-surface-500">{plan.calories}</p>
          <p className="text-xs font-medium text-brand-600">{plan.protein} protein</p>
        </div>
      </div>

      <h3 className="mt-4 text-xl font-bold text-surface-900">{plan.name}</h3>
      <p className="mt-2 text-sm leading-relaxed text-surface-500">{plan.description}</p>

      <ul className="mt-4 space-y-2">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-sm text-surface-600">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
            {feature}
          </li>
        ))}
      </ul>

      <Link
        href="/quiz"
        className="mt-6 inline-flex items-center gap-1 text-sm font-semibold text-brand-600 hover:text-brand-700"
      >
        Start on WhatsApp
        <ArrowRight className="h-4 w-4" />
      </Link>
    </article>
  )
}

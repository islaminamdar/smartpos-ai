import { Check } from 'lucide-react'
import type { PricingTier } from '@/lib/pricing'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function PricingCard({ tier, period }: { tier: PricingTier; period: 'monthly' | 'weekly' }) {
  const price = period === 'monthly' ? tier.monthlyPrice : tier.weeklyPrice
  const periodLabel = period === 'monthly' ? '/mo' : '/wk'

  return (
    <article
      className={cn(
        'relative flex flex-col rounded-2xl border p-6 md:p-8',
        tier.popular
          ? 'border-brand-500 bg-brand-50 shadow-float'
          : 'border-surface-200 bg-white shadow-card'
      )}
    >
      {tier.popular && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-brand-500 px-3 py-1 text-xs font-semibold text-white">
          Most popular
        </span>
      )}

      <h3 className="text-lg font-bold text-surface-900">{tier.name}</h3>
      <div className="mt-4">
        <span className="text-4xl font-bold tracking-tight text-surface-900">
          AED {price.toLocaleString()}
        </span>
        <span className="text-surface-500">{periodLabel}</span>
      </div>
      <p className="mt-1 text-sm font-medium text-brand-600">{tier.perMeal}</p>
      <p className="mt-1 text-sm text-surface-500">{tier.meals}</p>

      <ul className="mt-6 flex-1 space-y-3">
        {tier.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-sm text-surface-600">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" />
            {feature}
          </li>
        ))}
      </ul>

      <Button href="/quiz" variant={tier.popular ? 'primary' : 'secondary'} className="mt-8 w-full">
        Get started
      </Button>
    </article>
  )
}

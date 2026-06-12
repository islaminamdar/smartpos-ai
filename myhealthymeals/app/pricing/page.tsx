'use client'

import { useState } from 'react'
import { Section, SectionHeader } from '@/components/ui/section'
import { PricingCard } from '@/components/pricing/pricing-card'
import { ComparisonTable } from '@/components/pricing/comparison-table'
import { pricingTiers } from '@/lib/pricing'
import { cn } from '@/lib/utils'

export default function PricingPage() {
  const [period, setPeriod] = useState<'monthly' | 'weekly'>('monthly')

  return (
    <>
      <Section className="!pb-8">
        <SectionHeader
          eyebrow="Transparent pricing"
          title="Honest, all-in pricing. No hidden fees."
          description="From AED 22 per meal — cheaper than ordering daily delivery, fresher than cooking at home."
        />

        <div className="mx-auto mb-10 flex w-fit rounded-full border border-surface-200 bg-surface-50 p-1">
          {(['monthly', 'weekly'] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={cn(
                'rounded-full px-6 py-2 text-sm font-semibold capitalize transition-colors',
                period === p
                  ? 'bg-white text-surface-900 shadow-sm'
                  : 'text-surface-500 hover:text-surface-700'
              )}
            >
              {p === 'monthly' ? 'Monthly · 30 days' : 'Weekly · 7 days'}
            </button>
          ))}
        </div>

        <div className="grid gap-6 md:grid-cols-3">
          {pricingTiers.map((tier) => (
            <PricingCard key={tier.id} tier={tier} period={period} />
          ))}
        </div>

        <p className="mt-8 text-center text-sm text-surface-500">
          Prices include VAT. Free delivery in Business Bay, Downtown, DIFC, Marina &amp; JLT. Pause
          anytime.
        </p>
      </Section>

      <Section background="muted">
        <SectionHeader
          eyebrow="Why switch"
          title="MyHealthyMeals vs. delivery apps vs. cooking yourself"
        />
        <ComparisonTable />
      </Section>
    </>
  )
}

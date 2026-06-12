import type { Metadata } from 'next'
import { Section, SectionHeader } from '@/components/mhm/ui/section'
import { PlanCard } from '@/components/mhm/plans/plan-card'
import { Button } from '@/components/mhm/ui/button'
import { plans } from '@/lib/mhm/plans'

export const metadata: Metadata = {
  title: 'Meal Plans',
  description:
    'Eight dietitian-built meal plans from AED 22/meal. Weight loss, high protein, diabetic-friendly, family, corporate and more.',
}

export default function PlansPage() {
  return (
    <>
      <Section className="!pb-8">
        <SectionHeader
          eyebrow="Meal plans"
          title="One menu. Eight goals. Zero compromise."
          description="Every plan is dietitian-designed, halal-certified, and priced from AED 22 per meal. Pause or swap anytime."
        />
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan) => (
            <PlanCard key={plan.id} plan={plan} />
          ))}
        </div>
        <div className="mt-12 rounded-2xl bg-brand-50 p-8 text-center">
          <h3 className="text-xl font-bold text-surface-900">Not sure which plan?</h3>
          <p className="mt-2 text-surface-500">
            Take our 60-second quiz and we&apos;ll recommend the right plan for your goal.
          </p>
          <Button href="/quiz" className="mt-6">
            Take the quiz
          </Button>
        </div>
      </Section>
    </>
  )
}

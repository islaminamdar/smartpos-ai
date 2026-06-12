import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { Hero } from '@/components/home/hero'
import { TrustBar, PromiseGrid } from '@/components/home/trust-bar'
import { AudienceGrid } from '@/components/home/audience-grid'
import { HowItWorks } from '@/components/home/how-it-works'
import { LeadForm } from '@/components/home/lead-form'
import { FAQ } from '@/components/home/faq'
import { Section, SectionHeader } from '@/components/ui/section'
import { PlanCard } from '@/components/plans/plan-card'
import { MealCard } from '@/components/meals/meal-card'
import { PricingCard } from '@/components/pricing/pricing-card'
import { ComparisonTable } from '@/components/pricing/comparison-table'
import { Button } from '@/components/ui/button'
import { plans } from '@/lib/plans'
import { meals } from '@/lib/meals'
import { pricingTiers } from '@/lib/pricing'

export default function HomePage() {
  return (
    <>
      <Hero />
      <TrustBar />

      <Section background="white">
        <SectionHeader
          eyebrow="Our promise"
          title="What we promise on every delivery"
          description="Every meal is dietitian-designed, halal-certified, and cooked with measured ingredients."
        />
        <PromiseGrid />
      </Section>

      <Section background="muted">
        <SectionHeader
          eyebrow="Who we serve"
          title="Built for the way Dubai actually eats"
          description="Different goals, same kitchen. Pick the plan that matches where you are right now."
        />
        <AudienceGrid />
      </Section>

      <Section background="white">
        <SectionHeader
          eyebrow="Built around your goal"
          title="What are you eating for?"
          description="Six dietitian-built plans, all priced from AED 22 per meal. Switch any time."
        />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {plans.slice(0, 8).map((plan) => (
            <PlanCard key={plan.id} plan={plan} />
          ))}
        </div>
        <div className="mt-8 text-center">
          <Button href="/plans" variant="secondary">
            View all plans
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </Section>

      <Section id="how-it-works" background="muted">
        <SectionHeader
          eyebrow="How it works"
          title="From quiz to first hot meal in 24 hours"
          description="Designed to remove every reason people stay stuck on delivery apps at their desk."
        />
        <HowItWorks />
      </Section>

      <Section background="white">
        <SectionHeader
          eyebrow="Meal plans"
          title="One menu. Six goals. Zero compromise."
          description="Every plan is dietitian-designed, halal-certified, and priced from AED 22 per meal."
        />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {meals.slice(0, 6).map((meal) => (
            <MealCard key={meal.id} meal={meal} />
          ))}
        </div>
        <div className="mt-8 text-center">
          <Button href="/menu" variant="secondary">
            View full menu
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </Section>

      <Section background="muted">
        <SectionHeader
          eyebrow="Transparent pricing"
          title="Cheaper than ordering daily. Fresher than home."
          description="Typical delivery apps charge AED 35–50 per meal. Our Premium plan works out to AED 22."
        />
        <div className="grid gap-6 md:grid-cols-3">
          {pricingTiers.map((tier) => (
            <PricingCard key={tier.id} tier={tier} period="monthly" />
          ))}
        </div>
        <p className="mt-6 text-center text-sm text-surface-500">
          Prices include VAT. Free delivery in Business Bay, Downtown, DIFC, Marina &amp; JLT.
        </p>
        <div className="mt-4 text-center">
          <Link
            href="/pricing"
            className="text-sm font-semibold text-brand-600 hover:text-brand-700"
          >
            See full pricing &amp; comparison →
          </Link>
        </div>
      </Section>

      <Section background="white">
        <SectionHeader
          eyebrow="Why switch"
          title="MyHealthyMeals vs. delivery apps vs. cooking yourself"
          description="Built so you spend less time, less money and eat better than all three."
        />
        <ComparisonTable />
      </Section>

      <Section background="muted">
        <SectionHeader eyebrow="Common questions" title="Answered before you ask" />
        <FAQ />
      </Section>

      <Section background="brand">
        <SectionHeader
          eyebrow="First day on us"
          title="Start your plan — first day on us"
          description="We'll WhatsApp you in under 2 hours to confirm your plan and free first day."
        />
        <LeadForm />
      </Section>
    </>
  )
}

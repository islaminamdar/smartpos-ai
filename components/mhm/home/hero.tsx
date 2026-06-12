import { ArrowRight, Flame, Dumbbell, Wallet } from 'lucide-react'
import { Button } from '@/components/mhm/ui/button'
import { siteConfig } from '@/lib/mhm/site'

const stats = [
  { icon: Flame, label: 'From', value: '350', unit: 'kcal' },
  { icon: Dumbbell, label: 'Up to', value: '40', unit: 'g protein' },
  { icon: Wallet, label: 'From', value: '22', unit: 'AED/meal' },
]

export function Hero() {
  return (
    <section className="gradient-hero border-b border-surface-100 pb-16 pt-12 md:pb-24 md:pt-20">
      <div className="container-main">
        <div className="mx-auto max-w-3xl text-center">
          <p className="badge mb-6">Halal-certified Business Bay kitchen</p>

          <h1 className="text-balance text-4xl font-bold tracking-tight text-surface-900 sm:text-5xl md:text-6xl">
            Dubai&apos;s healthiest meals,{' '}
            <span className="text-brand-600">for people who want to lose weight.</span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-surface-500 md:text-lg">
            Dietitian-portioned. Halal certified. Fresh-cooked or flash-frozen. From AED 22 / meal —
            delivered to your door in {siteConfig.deliveryZones.join(', ')}.
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button href="/quiz" size="lg">
              Claim your free first day
              <ArrowRight className="h-4 w-4" />
            </Button>
            <Button href="/plans" variant="secondary" size="lg">
              Explore plans
            </Button>
          </div>
        </div>

        <div className="mx-auto mt-12 grid max-w-2xl grid-cols-3 gap-4 md:mt-16">
          {stats.map((stat) => (
            <div
              key={stat.unit}
              className="card animate-fade-up text-center"
              style={{ animationDelay: '0.1s' }}
            >
              <stat.icon className="mx-auto h-5 w-5 text-brand-500" />
              <p className="mt-2 text-xs font-medium text-surface-500">{stat.label}</p>
              <p className="mt-1 text-2xl font-bold text-surface-900 md:text-3xl">
                {stat.value}
                <span className="ml-1 text-sm font-medium text-surface-500">{stat.unit}</span>
              </p>
            </div>
          ))}
        </div>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          {siteConfig.trustBadges.map((badge) => (
            <span
              key={badge.label}
              className="inline-flex items-center gap-2 rounded-full border border-surface-200 bg-white px-4 py-2 text-xs font-medium text-surface-600 shadow-sm"
            >
              <span>{badge.icon}</span>
              {badge.label}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}

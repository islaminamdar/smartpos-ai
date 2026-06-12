import { siteConfig } from '@/lib/site'
import { Button } from '@/components/ui/button'

export function HowItWorks() {
  return (
    <div>
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        {siteConfig.howItWorks.map((step) => (
          <div key={step.step} className="relative">
            <div className="card h-full">
              <span className="text-xs font-bold text-brand-600">{step.step}</span>
              <span className="mt-2 block text-2xl">{step.icon}</span>
              <h3 className="mt-3 font-semibold text-surface-900">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-surface-500">{step.description}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
        <Button href="/quiz">Start the quiz</Button>
        <Button href="/pricing" variant="secondary">
          View pricing
        </Button>
      </div>
    </div>
  )
}

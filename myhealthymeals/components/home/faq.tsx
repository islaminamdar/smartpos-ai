'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

const faqs = [
  {
    q: 'Where do you deliver in Dubai?',
    a: 'We deliver free in Business Bay, Downtown Dubai, DIFC, Dubai Marina and JLT. Outside these zones, a flat AED 15 delivery fee applies. We hand-deliver — never via third-party riders.',
  },
  {
    q: 'How is the food cooked and delivered?',
    a: 'Hot Indian meals are cooked the same morning in our Business Bay kitchen, then hand-delivered hot within 30 minutes. International bowls are flash-frozen at peak freshness — delivered frozen so you heat and eat in minutes.',
  },
  {
    q: 'Can I pause or cancel my subscription?',
    a: 'Yes. You can pause any plan with 24 hours notice — for a day, a week, or a month — via a quick WhatsApp message. No cancellation fees, ever.',
  },
  {
    q: 'How does the free first day work?',
    a: "When you start any subscription plan, your first day is on us. Pick your plan, message us on WhatsApp, and we'll confirm within 2 hours.",
  },
  {
    q: 'Are the meals halal?',
    a: 'Yes — 100% halal certified. All our protein is sourced from halal-certified suppliers. The certificate is displayed at our kitchen and available on request.',
  },
  {
    q: "I'm diabetic — is this safe for me?",
    a: 'Our Diabetic-Friendly plan is designed with input from registered dietitians. Every meal is low glycaemic index, free of refined sugar and maida. Always work with your endocrinologist alongside any diet change.',
  },
]

export function FAQ() {
  const [open, setOpen] = useState<number | null>(0)

  return (
    <div className="mx-auto max-w-3xl divide-y divide-surface-200 rounded-2xl border border-surface-200 bg-white">
      {faqs.map((faq, i) => (
        <div key={faq.q}>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-4 px-6 py-5 text-left"
            onClick={() => setOpen(open === i ? null : i)}
          >
            <span className="font-semibold text-surface-900">{faq.q}</span>
            <ChevronDown
              className={cn(
                'h-5 w-5 shrink-0 text-surface-400 transition-transform',
                open === i && 'rotate-180'
              )}
            />
          </button>
          <div
            className={cn(
              'grid transition-all duration-300',
              open === i ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
            )}
          >
            <div className="overflow-hidden">
              <p className="px-6 pb-5 text-sm leading-relaxed text-surface-500">{faq.a}</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

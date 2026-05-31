'use client'
import { useState } from 'react'
import { MenuImportStep } from '@/components/onboarding/MenuImportStep'
import { WhatsAppLinkStep } from '@/components/onboarding/WhatsAppLinkStep'
import { PrinterStep } from '@/components/onboarding/PrinterStep'
import { DoneStep } from '@/components/onboarding/DoneStep'

const STEPS = ['Menu', 'WhatsApp', 'Printer', 'Done'] as const

export default function OnboardingPage() {
  const [step, setStep] = useState(0)
  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1))
  return (
    <main className="mx-auto max-w-2xl p-6">
      <ol className="mb-8 flex justify-between text-sm">
        {STEPS.map((s, i) => (
          <li key={s} className={i === step ? 'font-semibold' : 'text-muted-foreground'}>
            {i + 1}. {s}
          </li>
        ))}
      </ol>
      {step === 0 && <MenuImportStep onDone={next} />}
      {step === 1 && <WhatsAppLinkStep onDone={next} onSkip={next} />}
      {step === 2 && <PrinterStep onDone={next} onSkip={next} />}
      {step === 3 && <DoneStep />}
    </main>
  )
}

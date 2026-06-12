'use client'

import { useState } from 'react'
import { ArrowLeft, ArrowRight, Check } from 'lucide-react'
import Link from 'next/link'
import { AREAS, GOALS, buildQuizMessage, buildWhatsAppUrl, recommendPlan } from '@/lib/mhm/whatsapp'
import { cn } from '@/lib/utils'

const STEPS = ['Goal', 'Body', 'Preferences', 'Contact'] as const

const CUISINES = ['Indian', 'Mediterranean', 'Asian', 'Middle Eastern', 'International']

export default function QuizPage() {
  const [step, setStep] = useState(0)
  const [data, setData] = useState({
    goal: '',
    height: '',
    weight: '',
    diet: '',
    cuisines: [] as string[],
    allergies: '',
    area: '',
    phone: '',
    name: '',
  })

  const update = (field: string, value: string | string[]) =>
    setData((prev) => ({ ...prev, [field]: value }))

  const toggleCuisine = (cuisine: string) => {
    setData((prev) => ({
      ...prev,
      cuisines: prev.cuisines.includes(cuisine)
        ? prev.cuisines.filter((c) => c !== cuisine)
        : [...prev.cuisines, cuisine],
    }))
  }

  const canNext = () => {
    if (step === 0) return !!data.goal
    if (step === 1) return !!data.height && !!data.weight && !!data.diet
    if (step === 2) return !!data.area
    if (step === 3) return !!data.name && !!data.phone
    return false
  }

  const handleSubmit = () => {
    const message = buildQuizMessage(data)
    window.open(buildWhatsAppUrl(message), '_blank')
  }

  const recommended = data.goal ? recommendPlan(data.goal) : null

  const inputClass = cn(
    'w-full rounded-xl border border-surface-200 bg-white px-4 py-3 text-sm',
    'outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20'
  )

  return (
    <div className="section">
      <div className="container-main mx-auto max-w-xl">
        <Link
          href="/"
          className="mb-8 inline-flex items-center gap-1 text-sm text-surface-500 hover:text-surface-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to home
        </Link>

        <h1 className="text-3xl font-bold tracking-tight text-surface-900 md:text-4xl">
          Find your plan in 60 seconds
        </h1>
        <p className="mt-2 text-surface-500">
          Answer a few questions and we&apos;ll recommend the right plan for you.
        </p>

        <div className="mt-8 flex gap-2">
          {STEPS.map((label, i) => (
            <div key={label} className="flex-1">
              <div
                className={cn(
                  'h-1.5 rounded-full transition-colors',
                  i <= step ? 'bg-brand-500' : 'bg-surface-200'
                )}
              />
              <p
                className={cn(
                  'mt-2 text-xs font-medium',
                  i <= step ? 'text-brand-600' : 'text-surface-400'
                )}
              >
                {label}
              </p>
            </div>
          ))}
        </div>

        <div className="card mt-8">
          {step === 0 && (
            <div className="space-y-3">
              <p className="font-semibold text-surface-900">What&apos;s your main goal?</p>
              {GOALS.map((goal) => (
                <button
                  key={goal}
                  type="button"
                  onClick={() => update('goal', goal)}
                  className={cn(
                    'flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left text-sm transition-colors',
                    data.goal === goal
                      ? 'border-brand-500 bg-brand-50 text-brand-700'
                      : 'border-surface-200 hover:border-surface-300'
                  )}
                >
                  {goal}
                  {data.goal === goal && <Check className="h-4 w-4" />}
                </button>
              ))}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <label className="block">
                <span className="text-sm font-medium text-surface-700">Height (cm)</span>
                <input
                  className={cn(inputClass, 'mt-1.5')}
                  type="number"
                  placeholder="170"
                  value={data.height}
                  onChange={(e) => update('height', e.target.value)}
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-surface-700">Weight (kg)</span>
                <input
                  className={cn(inputClass, 'mt-1.5')}
                  type="number"
                  placeholder="75"
                  value={data.weight}
                  onChange={(e) => update('weight', e.target.value)}
                />
              </label>
              <div>
                <span className="text-sm font-medium text-surface-700">Diet preference</span>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {['Vegetarian', 'Non-vegetarian'].map((diet) => (
                    <button
                      key={diet}
                      type="button"
                      onClick={() => update('diet', diet)}
                      className={cn(
                        'rounded-xl border px-4 py-3 text-sm transition-colors',
                        data.diet === diet
                          ? 'border-brand-500 bg-brand-50 text-brand-700'
                          : 'border-surface-200 hover:border-surface-300'
                      )}
                    >
                      {diet}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div>
                <span className="text-sm font-medium text-surface-700">
                  Favourite cuisines (pick any)
                </span>
                <div className="mt-2 flex flex-wrap gap-2">
                  {CUISINES.map((cuisine) => (
                    <button
                      key={cuisine}
                      type="button"
                      onClick={() => toggleCuisine(cuisine)}
                      className={cn(
                        'rounded-full border px-4 py-2 text-sm transition-colors',
                        data.cuisines.includes(cuisine)
                          ? 'border-brand-500 bg-brand-50 text-brand-700'
                          : 'border-surface-200 hover:border-surface-300'
                      )}
                    >
                      {cuisine}
                    </button>
                  ))}
                </div>
              </div>
              <label className="block">
                <span className="text-sm font-medium text-surface-700">Delivery area</span>
                <select
                  className={cn(inputClass, 'mt-1.5')}
                  value={data.area}
                  onChange={(e) => update('area', e.target.value)}
                >
                  <option value="">Select your area…</option>
                  {AREAS.map((area) => (
                    <option key={area} value={area}>
                      {area}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-sm font-medium text-surface-700">Allergies (optional)</span>
                <input
                  className={cn(inputClass, 'mt-1.5')}
                  placeholder="e.g. nuts, dairy"
                  value={data.allergies}
                  onChange={(e) => update('allergies', e.target.value)}
                />
              </label>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              {recommended && (
                <div className="rounded-xl bg-brand-50 p-4 text-center">
                  <p className="text-sm text-brand-600">Recommended plan</p>
                  <p className="mt-1 text-xl font-bold text-brand-800">{recommended}</p>
                  <p className="mt-1 text-xs text-brand-600">First day on us when you start</p>
                </div>
              )}
              <label className="block">
                <span className="text-sm font-medium text-surface-700">Your name</span>
                <input
                  className={cn(inputClass, 'mt-1.5')}
                  value={data.name}
                  onChange={(e) => update('name', e.target.value)}
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-surface-700">WhatsApp number</span>
                <input
                  className={cn(inputClass, 'mt-1.5')}
                  type="tel"
                  placeholder="+971 50 123 4567"
                  value={data.phone}
                  onChange={(e) => update('phone', e.target.value)}
                />
              </label>
            </div>
          )}

          <div className="mt-6 flex gap-3">
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep(step - 1)}
                className="btn-secondary flex-1"
              >
                Back
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <button
                type="button"
                onClick={() => setStep(step + 1)}
                disabled={!canNext()}
                className="btn-primary flex-1 disabled:opacity-40"
              >
                Continue
                <ArrowRight className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canNext()}
                className="btn-primary flex-1 disabled:opacity-40"
              >
                Send via WhatsApp
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

'use client'

import { useState } from 'react'
import { Send } from 'lucide-react'
import { AREAS, GOALS, buildLeadMessage, buildWhatsAppUrl } from '@/lib/mhm/whatsapp'
import { cn } from '@/lib/utils'

const inputClass = cn(
  'w-full rounded-xl border border-surface-200 bg-white px-4 py-2.5 text-sm text-surface-900',
  'outline-none transition-colors focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20'
)

export function LeadForm() {
  const [form, setForm] = useState({
    name: '',
    phone: '',
    nationality: '',
    diet: '',
    area: '',
    goal: '',
    currentService: '',
    allergies: '',
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const message = buildLeadMessage(form)
    window.open(buildWhatsAppUrl(message), '_blank')
  }

  const update = (field: string, value: string) => setForm((prev) => ({ ...prev, [field]: value }))

  return (
    <form onSubmit={handleSubmit} className="card mx-auto max-w-2xl">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Your name" required>
          <input
            className={inputClass}
            value={form.name}
            onChange={(e) => update('name', e.target.value)}
            required
          />
        </Field>
        <Field label="WhatsApp number" required>
          <input
            className={inputClass}
            type="tel"
            placeholder="+971 50 123 4567"
            value={form.phone}
            onChange={(e) => update('phone', e.target.value)}
            required
          />
        </Field>
        <Field label="Nationality">
          <input
            className={inputClass}
            value={form.nationality}
            onChange={(e) => update('nationality', e.target.value)}
          />
        </Field>
        <Field label="Veg or non-veg?" required>
          <select
            className={inputClass}
            value={form.diet}
            onChange={(e) => update('diet', e.target.value)}
            required
          >
            <option value="">Select…</option>
            <option value="Vegetarian">Vegetarian</option>
            <option value="Non-vegetarian">Non-vegetarian</option>
          </select>
        </Field>
        <Field label="Area" required>
          <select
            className={inputClass}
            value={form.area}
            onChange={(e) => update('area', e.target.value)}
            required
          >
            <option value="">Select your area…</option>
            {AREAS.map((area) => (
              <option key={area} value={area}>
                {area}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Goal" required>
          <select
            className={inputClass}
            value={form.goal}
            onChange={(e) => update('goal', e.target.value)}
            required
          >
            <option value="">Select…</option>
            {GOALS.map((goal) => (
              <option key={goal} value={goal}>
                {goal}
              </option>
            ))}
          </select>
        </Field>
        <Field label="On another meal service?">
          <select
            className={inputClass}
            value={form.currentService}
            onChange={(e) => update('currentService', e.target.value)}
          >
            <option value="">Select…</option>
            <option value="No — new to this">No — new to this</option>
            <option value="Yes, subscribed elsewhere">Yes, subscribed elsewhere</option>
          </select>
        </Field>
        <Field label="Allergies (optional)">
          <input
            className={inputClass}
            value={form.allergies}
            onChange={(e) => update('allergies', e.target.value)}
          />
        </Field>
      </div>

      <button type="submit" className="btn-primary mt-6 w-full">
        <Send className="h-4 w-4" />
        Send via WhatsApp
      </button>

      <p className="mt-4 text-center text-xs text-surface-500">
        We&apos;ll never spam you. Start any plan and your first day is on us.
      </p>
    </form>
  )
}

function Field({
  label,
  children,
  required,
}: {
  label: string
  children: React.ReactNode
  required?: boolean
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-surface-700">
        {label}
        {required && <span className="text-brand-500"> *</span>}
      </span>
      {children}
    </label>
  )
}

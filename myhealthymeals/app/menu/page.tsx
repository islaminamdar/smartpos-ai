'use client'

import { useMemo, useState } from 'react'
import { Section, SectionHeader } from '@/components/ui/section'
import { MealCard } from '@/components/meals/meal-card'
import { meals, mealFilters } from '@/lib/meals'
import { cn } from '@/lib/utils'

export default function MenuPage() {
  const [filter, setFilter] = useState('all')

  const filtered = useMemo(() => {
    if (filter === 'all') return meals
    return meals.filter((meal) => meal.plans.includes(filter))
  }, [filter])

  return (
    <Section>
      <SectionHeader
        eyebrow="This week's menu"
        title="Dietitian-designed meals, chef-cooked"
        description="Every meal card shows calories, macros, and allergens. Tap to expand full nutrition."
      />

      <div className="mb-8 flex flex-wrap gap-2">
        {mealFilters.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={cn(
              'rounded-full border px-4 py-2 text-sm font-medium transition-colors',
              filter === f.id
                ? 'border-brand-500 bg-brand-50 text-brand-700'
                : 'border-surface-200 text-surface-600 hover:border-surface-300'
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map((meal) => (
          <MealCard key={meal.id} meal={meal} />
        ))}
      </div>

      {filtered.length === 0 && (
        <p className="py-12 text-center text-surface-500">
          No meals match this filter. Try another plan.
        </p>
      )}
    </Section>
  )
}

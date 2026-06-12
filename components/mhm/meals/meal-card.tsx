'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { Meal } from '@/lib/mhm/meals'
import { cn } from '@/lib/utils'

export function MealCard({ meal }: { meal: Meal }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <article className="card-hover flex flex-col">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-100 text-2xl">
            {meal.emoji}
          </span>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-surface-500">
              {meal.cuisine} · {meal.mealType}
            </p>
            <h3 className="mt-0.5 font-semibold text-surface-900">{meal.name}</h3>
          </div>
        </div>
        <span className="macro-badge shrink-0">{meal.calories} kcal</span>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2">
        <MacroPill label="Protein" value={`${meal.protein}g`} />
        <MacroPill label="Carbs" value={`${meal.carbs}g`} />
        <MacroPill label="Fat" value={`${meal.fat}g`} />
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {meal.tags.slice(0, 3).map((tag) => (
          <span key={tag} className="badge text-[10px]">
            {tag}
          </span>
        ))}
      </div>

      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="mt-4 flex items-center gap-1 text-sm font-medium text-brand-600 hover:text-brand-700"
      >
        {expanded ? 'Hide details' : 'View nutrition'}
        {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>

      <div
        className={cn(
          'grid transition-all duration-300',
          expanded ? 'mt-3 grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        )}
      >
        <div className="overflow-hidden">
          <div className="rounded-xl bg-surface-50 p-4 text-sm">
            <p className="font-medium text-surface-700">Ingredients</p>
            <p className="mt-1 text-surface-500">{meal.ingredients}</p>
            {meal.allergens.length > 0 && (
              <p className="mt-3 text-xs text-surface-500">Contains: {meal.allergens.join(', ')}</p>
            )}
          </div>
        </div>
      </div>
    </article>
  )
}

function MacroPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface-50 px-3 py-2 text-center">
      <p className="text-[10px] font-medium uppercase tracking-wide text-surface-500">{label}</p>
      <p className="mt-0.5 text-sm font-semibold text-surface-900">{value}</p>
    </div>
  )
}

'use client'

import { useId } from 'react'

type Choice<Value extends string> = { value: Value; label: string }

/** Native radios keep single-choice keyboard, form and reset behaviour. */
export default function TapChoices<Value extends string>({
  label,
  options,
  value,
  defaultValue,
  onChange,
  name,
  disabled = false,
  scrollable = false,
}: {
  label: string
  options: readonly Choice<Value>[]
  value?: Value
  defaultValue?: Value
  onChange?: (value: Value) => void
  name?: string
  disabled?: boolean
  scrollable?: boolean
}) {
  const id = useId()
  return (
    <fieldset
      className={['lc-tap-choices', scrollable ? 'lc-tap-choices-scroll' : '']
        .filter(Boolean)
        .join(' ')}
      disabled={disabled}
    >
      <legend>{label}</legend>
      {scrollable && <p className="lc-tap-hint">Swipe or scroll for more categories.</p>}
      <div className="lc-tap-options">
        {options.map((option) => (
          <label className="lc-tap-choice" key={option.value}>
            <input
              type="radio"
              name={name ?? id}
              value={option.value}
              checked={value === undefined ? undefined : value === option.value}
              defaultChecked={value === undefined ? defaultValue === option.value : undefined}
              onChange={onChange ? () => onChange(option.value) : undefined}
              onFocus={
                scrollable
                  ? (event) => {
                      // Focus follows the full tile; only move this horizontal rail.
                      const tile = event.currentTarget.parentElement
                      const rail = tile?.parentElement
                      if (!tile || !rail) return
                      const choiceBounds = tile.getBoundingClientRect()
                      const railBounds = rail.getBoundingClientRect()
                      const gutter = 4
                      if (choiceBounds.right > railBounds.right - gutter)
                        rail.scrollLeft += choiceBounds.right - railBounds.right + gutter
                      else if (choiceBounds.left < railBounds.left + gutter)
                        rail.scrollLeft += choiceBounds.left - railBounds.left - gutter
                    }
                  : undefined
              }
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import TapChoices from '@/components/pos/TapChoices'

const options = [
  { value: 'in', label: 'Cash in' },
  { value: 'out', label: 'Cash out' },
] as const

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('changes one selected choice without submitting its surrounding form', () => {
  const submitted = vi.fn((event) => event.preventDefault())
  function Example() {
    const [direction, setDirection] = useState<'in' | 'out'>('in')
    return (
      <form onSubmit={submitted}>
        <TapChoices
          label="Direction"
          name="direction"
          options={options}
          value={direction}
          onChange={setDirection}
        />
      </form>
    )
  }
  render(<Example />)
  const group = screen.getByRole('group', { name: 'Direction' })
  expect(within(group).getByRole('radio', { name: 'Cash in' })).toBeChecked()
  fireEvent.click(within(group).getByText('Cash out'))
  expect(within(group).getByRole('radio', { name: 'Cash out' })).toBeChecked()
  expect(within(group).getByRole('radio', { name: 'Cash in' })).not.toBeChecked()
  expect(submitted).not.toHaveBeenCalled()
})

it('keeps independent groups separate and restores the cash direction on form reset', () => {
  const { container } = render(
    <form>
      <TapChoices label="Direction" name="direction" defaultValue="in" options={options} />
      <TapChoices label="Another group" defaultValue="out" options={options} />
    </form>
  )
  const first = screen.getByRole('group', { name: 'Direction' })
  const other = screen.getByRole('group', { name: 'Another group' })
  fireEvent.click(within(first).getByRole('radio', { name: 'Cash out' }))
  const form = container.querySelector('form')!
  expect(new FormData(form).get('direction')).toBe('out')
  expect(within(other).getByRole('radio', { name: 'Cash out' })).toBeChecked()
  form.reset()
  expect(new FormData(form).get('direction')).toBe('in')
})

it('locks every choice using native disabled fieldset semantics', () => {
  render(<TapChoices label="Direction" defaultValue="in" options={options} disabled />)
  for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled()
})

it('scrolls the entire keyboard-focused category into its rail without moving the page', () => {
  const pageScroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  const { container } = render(
    <TapChoices label="Category" defaultValue="in" options={options} scrollable />
  )
  const rail = container.querySelector<HTMLElement>('.lc-tap-options')!
  const radio = screen.getByRole('radio', { name: 'Cash out' })
  const tile = radio.parentElement!
  vi.spyOn(rail, 'getBoundingClientRect').mockReturnValue({ left: 10, right: 350 } as DOMRect)
  const bounds = vi.spyOn(tile, 'getBoundingClientRect')
  bounds.mockReturnValue({ left: 300, right: 420 } as DOMRect)
  fireEvent.focus(radio)
  expect(rail.scrollLeft).toBe(74)
  bounds.mockReturnValue({ left: -30, right: 90 } as DOMRect)
  fireEvent.focus(radio)
  expect(rail.scrollLeft).toBe(30)
  expect(pageScroll).not.toHaveBeenCalled()
})

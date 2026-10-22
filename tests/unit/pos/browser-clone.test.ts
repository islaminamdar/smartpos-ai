import { describe, expect, it } from 'vitest'
import { browserClone } from '@/lib/pos/browser-clone'

describe('browserClone', () => {
  it('deep-copies POS records without structuredClone', () => {
    const source = { id: 'shift-open', body: { line: { amountFils: 1250 } } }
    const copy = browserClone(source, undefined)
    copy.body.line.amountFils = 500
    expect(copy).toEqual({ id: 'shift-open', body: { line: { amountFils: 500 } } })
    expect(source.body.line.amountFils).toBe(1250)
  })

  it('keeps native structured clone when supplied', () => {
    const native = <T>(value: T) => ({ ...value }) as T
    expect(browserClone({ id: 'command' }, native)).toEqual({ id: 'command' })
  })
})

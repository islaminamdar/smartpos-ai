import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
vi.mock('server-only', () => ({}))
import { resolveMerchantBranding } from '@/lib/pos/server/branding'
import { matchingMerchantBranding, merchantBrandingSchema } from '@/lib/pos/branding'
import { liveBootstrapSchema } from '@/lib/pos/server/live-contracts'
import FiscalReceipt from '@/components/pos/FiscalReceipt'
import MerchantIdentity from '@/components/pos/branding/MerchantIdentity'
import { boot, invoice } from './fixtures/partial-return-ui'

const scope = {
  organizationId: '8feaa1e9-c27d-44e7-94ae-60944c131c14',
  branchId: '79d4b844-1fd4-4cdf-a32f-db9329d75f3a',
  profileId: '04492700-3757-43cb-842e-18163223967a',
}
const other = '99999999-0000-4000-8000-000000000001'
afterEach(cleanup)
describe('verified merchant presentation identity', () => {
  it('resolves the verified branch and fails closed for each mismatched identity', () => {
    expect(resolveMerchantBranding(scope)?.displayName).toBe('Suleman Usman Mithaiwala')
    for (const key of ['organizationId', 'branchId', 'profileId'])
      expect(resolveMerchantBranding({ ...scope, [key]: other })).toBeNull()
    expect(resolveMerchantBranding({ ...scope, profileId: null })).toBeNull()
  })
  it('does not expose mutable registry state', () => {
    const brand = resolveMerchantBranding(scope)!
    brand.displayName = 'changed'
    expect(resolveMerchantBranding(scope)?.displayName).toBe('Suleman Usman Mithaiwala')
  })
  it('accepts only the local verified asset and theme, never arbitrary URLs/CSS', () => {
    const brand = resolveMerchantBranding(scope)!
    expect(merchantBrandingSchema.safeParse(brand).success).toBe(true)
    for (const logoPath of [
      'https://elsewhere.example/logo.png',
      'javascript:alert(1)',
      '/wrong.png',
    ])
      expect(merchantBrandingSchema.safeParse({ ...brand, logoPath }).success).toBe(false)
    expect(merchantBrandingSchema.safeParse({ ...brand, theme: 'other' }).success).toBe(false)
  })
  it('retains backward-compatible generic bootstrap and generic platform identity', () => {
    expect(liveBootstrapSchema.safeParse(boot).success).toBe(true)
    render(<MerchantIdentity branding={null} />)
    expect(screen.getByText('Internext')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
  it('requires profile, branch and tenant identity before decorating a fiscal document', () => {
    const brand = resolveMerchantBranding(scope)!
    for (const key of ['organizationId', 'branchId', 'profileId'])
      expect(matchingMerchantBranding(brand, { ...scope, [key]: other })).toBeNull()
    const { rerender } = render(<FiscalReceipt document={invoice} branding={brand} />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    const matching = {
      ...brand,
      organizationId: invoice.merchant.organizationId,
      branchId: invoice.merchant.branchId,
      profileId: invoice.merchant.id,
    }
    const original = structuredClone(invoice)
    rerender(<FiscalReceipt document={invoice} branding={matching} />)
    expect(screen.getByRole('img', { name: /Mithaiwala logo/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: invoice.merchant.legalName })).toBeInTheDocument()
    expect(screen.getByText(`TRN ${invoice.merchant.trn}`)).toBeInTheDocument()
    expect(invoice).toEqual(original)
  })
})

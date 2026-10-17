import 'server-only'
import { matchingMerchantBranding, type MerchantBranding } from '../branding'

// Explicit verified tenant registry: no name/substring matching and no global default brand.
// Add another tenant only after its asset and exact business scope have been verified.
const verifiedBrands: readonly MerchantBranding[] = [
  {
    organizationId: '8feaa1e9-c27d-44e7-94ae-60944c131c14',
    branchId: '79d4b844-1fd4-4cdf-a32f-db9329d75f3a',
    profileId: '04492700-3757-43cb-842e-18163223967a',
    displayName: 'Suleman Usman Mithaiwala',
    logoPath: '/pos-assets/brand/mithaiwala.webp',
    theme: 'mithaiwala',
  },
]

export function resolveMerchantBranding(scope: {
  organizationId: string
  branchId: string
  profileId: string | null
}): MerchantBranding | null {
  if (!scope.profileId) return null
  const match = verifiedBrands.find((brand) =>
    matchingMerchantBranding(brand, { ...scope, profileId: scope.profileId! })
  )
  return match ? { ...match } : null
}

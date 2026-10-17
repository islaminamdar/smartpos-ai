import { z } from 'zod'

/** Presentation metadata only. Fiscal documents retain their immutable merchant profile. */
export const merchantBrandingSchema = z
  .object({
    organizationId: z.string().uuid(),
    branchId: z.string().uuid(),
    profileId: z.string().uuid(),
    displayName: z.string().min(1).max(120),
    logoPath: z.literal('/pos-assets/brand/mithaiwala.webp'),
    theme: z.literal('mithaiwala'),
  })
  .strict()
export type MerchantBranding = z.infer<typeof merchantBrandingSchema>

export function matchingMerchantBranding(
  branding: MerchantBranding | null | undefined,
  scope: { organizationId: string; branchId: string; profileId: string } | null | undefined
): MerchantBranding | null {
  if (
    !branding ||
    !scope ||
    branding.organizationId !== scope.organizationId ||
    branding.branchId !== scope.branchId ||
    branding.profileId !== scope.profileId
  )
    return null
  return branding
}

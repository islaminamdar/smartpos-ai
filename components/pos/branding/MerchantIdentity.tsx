import type { MerchantBranding } from '@/lib/pos/branding'

/** The server supplies a verified brand; generic tenants retain the shared platform identity. */
export default function MerchantIdentity({
  branding,
  kitchen = false,
}: {
  branding: MerchantBranding | null
  kitchen?: boolean
}) {
  if (!branding)
    return (
      <span>
        Internext <strong>POS</strong>
      </span>
    )
  return (
    <>
      {/* Fixed local asset: preserve the authentic logo without remote image requests. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={branding.logoPath} width={48} height={48} alt="" />
      <span className="lc-merchant-name">
        <strong>{branding.displayName}</strong>
        <small>{kitchen ? 'Kitchen' : 'Powered by Internext POS'}</small>
      </span>
    </>
  )
}

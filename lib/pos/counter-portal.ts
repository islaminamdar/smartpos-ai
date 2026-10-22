export const counterPortalSlug = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export type CounterPortal = {
  slug: string
  organizationId: string
  branchId: string
  displayName: string
}

export function validCounterPortalSlug(value: string): boolean {
  return counterPortalSlug.test(value)
}

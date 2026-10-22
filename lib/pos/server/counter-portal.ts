import 'server-only'

import { validCounterPortalSlug, type CounterPortal } from '../counter-portal'
import { PosServerError, posClient } from './client'

export async function activeCounterPortal(slug: string): Promise<CounterPortal | null> {
  if (!validCounterPortalSlug(slug)) return null
  const { data, error } = await posClient(undefined, true)
    .from('pos_counter_portals')
    .select('slug,organization_id,branch_id,display_name')
    .eq('slug', slug)
    .eq('active', true)
    .maybeSingle()
  if (error) throw new PosServerError('portal_service_unavailable', 503)
  if (!data) return null
  return {
    slug: data.slug,
    organizationId: data.organization_id,
    branchId: data.branch_id,
    displayName: data.display_name,
  }
}

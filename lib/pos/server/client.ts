import { createServer } from '@/lib/db/supabase'
import type { SupabaseClient } from '@supabase/supabase-js'

export type PosErrorCode = 'setup_required' | 'authentication_required' | 'storage_unavailable'
export class PosServerError extends Error {
  constructor(public readonly code: PosErrorCode, public readonly status: number) { super(code) }
}

export async function authenticatedPosClient() {
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    throw new PosServerError('setup_required', 503)
  }
  // Reuse the existing cookie-based server client, never service-role credentials.
  // The new schema is isolated from the legacy hand-written Database type.
  const client = await createServer() as unknown as SupabaseClient
  const { data, error } = await client.auth.getUser()
  if (error || !data.user) throw new PosServerError('authentication_required', 401)
  return { client, user: data.user }
}

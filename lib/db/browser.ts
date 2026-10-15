import { createBrowserClient } from '@supabase/ssr'
import type { Database } from './types'

// Keep browser consumers separate from cookie/server-only imports.
export function createBrowser() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}

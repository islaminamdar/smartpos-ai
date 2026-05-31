'use server'
import { createServer, createServiceRole } from '@/lib/db/supabase'
import { redirect } from 'next/navigation'
import { z } from 'zod'

const Signup = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(2),
  restaurantName: z.string().min(2),
})

export async function signup(formData: FormData) {
  const parsed = Signup.parse({
    email: formData.get('email'),
    password: formData.get('password'),
    fullName: formData.get('fullName'),
    restaurantName: formData.get('restaurantName'),
  })
  const sb = await createServer()
  const { data: auth, error } = await sb.auth.signUp({
    email: parsed.email,
    password: parsed.password,
  })
  if (error || !auth.user) throw error ?? new Error('Signup failed')

  const admin = createServiceRole()
  const { data: tenant } = await admin
    .from('tenants')
    .insert({
      name: parsed.restaurantName,
    })
    .select('id')
    .single()
  await admin.from('users').insert({
    id: auth.user.id,
    tenant_id: tenant!.id,
    role: 'owner',
    full_name: parsed.fullName,
  })

  redirect('/onboarding')
}

export async function login(formData: FormData) {
  const sb = await createServer()
  const { error } = await sb.auth.signInWithPassword({
    email: String(formData.get('email')),
    password: String(formData.get('password')),
  })
  if (error) throw error
  redirect('/dashboard')
}

export async function logout() {
  const sb = await createServer()
  await sb.auth.signOut()
  redirect('/login')
}

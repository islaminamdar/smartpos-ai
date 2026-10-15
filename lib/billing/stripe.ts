import Stripe from 'stripe'

/** Legacy automatic billing is optional. Importing a route must never initialize it. */
export function getStripeClient(): Stripe | null {
  const secret = process.env.STRIPE_SECRET_KEY?.trim()
  if (!secret) return null
  return new Stripe(secret, { apiVersion: '2024-06-20' as any })
}

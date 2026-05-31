import Stripe from 'stripe'
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
  apiVersion: '2024-06-20' as any,
})
export const PRICE_STARTER_AED_100 = process.env.STRIPE_PRICE_STARTER ?? ''

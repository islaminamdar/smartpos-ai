export type PricingTier = {
  id: string
  name: string
  monthlyPrice: number
  weeklyPrice: number
  perMeal: string
  meals: string
  features: string[]
  popular?: boolean
}

export const pricingTiers: PricingTier[] = [
  {
    id: 'basic',
    name: 'Basic',
    monthlyPrice: 999,
    weeklyPrice: 279,
    perMeal: '~AED 33 per meal',
    meals: '1 meal per day · 30 days',
    features: [
      'Lunch OR dinner',
      'Free delivery in 5 zones',
      'Pause anytime, no fees',
      'WhatsApp ordering',
    ],
  },
  {
    id: 'standard',
    name: 'Standard',
    monthlyPrice: 1499,
    weeklyPrice: 419,
    perMeal: '~AED 25 per meal',
    meals: '2 meals per day · 30 days',
    features: [
      'Lunch + dinner',
      '1 free swap day / week',
      'Free delivery in 5 zones',
      'Dietitian check-in',
    ],
    popular: true,
  },
  {
    id: 'premium',
    name: 'Premium',
    monthlyPrice: 1999,
    weeklyPrice: 559,
    perMeal: '~AED 22 per meal',
    meals: '3 meals per day · 30 days',
    features: [
      'Breakfast + lunch + dinner',
      '2 free swap days / week',
      'Free delivery + priority slot',
      'Monthly dietitian 1-on-1',
    ],
  },
]

export const comparisonRows = [
  { feature: 'Fresh-cooked or flash-frozen', us: true, apps: false, home: 'sometimes' },
  { feature: 'Dietitian-portioned macros', us: true, apps: false, home: false },
  { feature: 'Halal-certified protein', us: true, apps: 'mixed', home: 'depends' },
  { feature: 'No maida / refined sugar', us: true, apps: false, home: 'sometimes' },
  { feature: 'Average price per meal', us: 'AED 22–33', apps: 'AED 35–50', home: 'AED 12–18 + 2h' },
  { feature: 'Pause anytime', us: true, apps: '—', home: '—' },
  { feature: 'Doctor-reviewed diabetic option', us: true, apps: false, home: false },
] as const

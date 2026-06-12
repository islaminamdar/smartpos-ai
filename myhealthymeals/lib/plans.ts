export type Plan = {
  id: string
  name: string
  emoji: string
  calories: string
  protein: string
  description: string
  features: string[]
  href: string
  audience: string
}

export const plans: Plan[] = [
  {
    id: 'weight-loss',
    name: 'Weight Loss',
    emoji: '🏃‍♀️',
    calories: '350–450 kcal',
    protein: '28–35g',
    description:
      'Dietitian-portioned meals under 450 kcal, high in protein and fibre to keep you full while you drop fat.',
    features: [
      'Calorie-controlled portions',
      'High-fibre, high-protein',
      'No refined sugar, no maida',
      'Weekly weigh-in check-in',
    ],
    href: '/plans#weight-loss',
    audience: 'Weight loss',
  },
  {
    id: 'high-protein',
    name: 'High Protein',
    emoji: '💪',
    calories: '500–650 kcal',
    protein: '30–40g',
    description:
      'Chef-crafted meals delivering 30–40g of clean protein per portion — grilled chicken, paneer, lean keema, lentils.',
    features: [
      '30–40g protein per meal',
      'Complex carbs for energy',
      'Pre / post-workout friendly',
      'Halal-certified protein sources',
    ],
    href: '/plans#high-protein',
    audience: 'Gym & athletes',
  },
  {
    id: 'diabetic-friendly',
    name: 'Diabetic-Friendly',
    emoji: '🩺',
    calories: '400–500 kcal',
    protein: '25–32g',
    description:
      'Designed with input from registered dietitians for stable blood sugar — slow-release carbs, balanced macros.',
    features: [
      'Low glycaemic index ingredients',
      'No refined sugar / no maida',
      'Dietitian-designed menu',
      'Diabetes-friendly snacks',
    ],
    href: '/plans#diabetic-friendly',
    audience: 'Diabetics',
  },
  {
    id: 'lean-balanced',
    name: 'Lean & Balanced',
    emoji: '⚖️',
    calories: '450–550 kcal',
    protein: '25–30g',
    description:
      'A balanced macro plan for professionals who already eat well but want to skip the daily decision fatigue.',
    features: [
      'Balanced macros',
      'Mediterranean + Indian rotation',
      'Office-friendly portions',
      'Pause anytime',
    ],
    href: '/plans#lean-balanced',
    audience: 'Busy professionals',
  },
  {
    id: 'family',
    name: 'Family Plan',
    emoji: '👨‍👩‍👧',
    calories: '500–650 kcal',
    protein: '25–32g',
    description:
      'Hot family-style meals delivered to your door so weekday dinners stop being a battle.',
    features: [
      'Family-style portions (2 / 4)',
      'Kid-friendly Indian menu',
      'Same-morning prep',
      'Flexible delivery times',
    ],
    href: '/plans#family',
    audience: 'Working parents',
  },
  {
    id: 'corporate',
    name: 'Corporate Wellness',
    emoji: '🏢',
    calories: '450–650 kcal',
    protein: '28–38g',
    description:
      'Bulk healthy lunches delivered to Business Bay, DIFC and Downtown offices. VAT invoicing included.',
    features: [
      'VAT invoicing for finance',
      'Account manager included',
      'Dietary requirements handled',
      'Min 10 meals / delivery',
    ],
    href: '/plans#corporate',
    audience: 'Teams & offices',
  },
  {
    id: 'indian-tiffin',
    name: 'Indian Tiffin',
    emoji: '🍛',
    calories: '450–600 kcal',
    protein: '20–30g',
    description:
      'Authentic Indian home-style tiffin — dal makhani, rajma, paneer bhurji, khichdi, butter chicken lite.',
    features: [
      '5–7 ml oil per meal',
      'Zero maida, zero MSG',
      'Halal certified',
      'Hot in 30 minutes',
    ],
    href: '/plans#indian-tiffin',
    audience: 'Indian tiffin lovers',
  },
  {
    id: 'heart-healthy',
    name: 'Heart-Healthy',
    emoji: '❤️',
    calories: '400–500 kcal',
    protein: '25–35g',
    description:
      'A Mediterranean-meets-Indian rotation designed to lower LDL cholesterol — high in soluble fibre and omega-3.',
    features: [
      'Soluble-fibre rich ingredients',
      'Omega-3 from fish, walnuts, flax',
      'Low saturated fat',
      'No trans fats, no deep-fried',
    ],
    href: '/plans#heart-healthy',
    audience: 'Heart health',
  },
]

export const audiences = [
  {
    emoji: '💼',
    title: 'Busy professionals',
    description:
      'Working 50+ hour weeks? Hot meals delivered to your desk in Business Bay, DIFC, Downtown, Marina or JLT.',
  },
  {
    emoji: '🩺',
    title: 'Diabetics',
    description:
      'Dietitian-designed low-GI menu. Members tell us they feel more in control of their blood sugar.',
  },
  {
    emoji: '💪',
    title: 'Gym & athletes',
    description:
      '30–40g halal protein per meal, calibrated to your training schedule. Real food, no shakes.',
  },
  {
    emoji: '⚖️',
    title: 'Weight loss',
    description:
      'Under 450 kcal per meal, dietitian-portioned. No calorie counting, no hunger games.',
  },
  {
    emoji: '👨‍👩‍👧',
    title: 'Working parents',
    description:
      'Hot family dinners delivered at 7 PM. Kids actually finish their plates. You skip the chaos.',
  },
]

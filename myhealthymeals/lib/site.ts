export const siteConfig = {
  name: 'MyHealthyMeals',
  domain: 'myhealthymeals.ae',
  whatsapp: '971501234567',
  tagline: "Dubai's healthiest meals, for people who want to lose weight.",
  deliveryZones: ['Business Bay', 'Downtown Dubai', 'DIFC', 'Dubai Marina', 'JLT'],
  trustBadges: [
    { icon: '🌅', label: 'Fresh or flash-frozen' },
    { icon: '🩺', label: 'Doctor reviewed' },
    { icon: '☪︎', label: 'Halal certified' },
    { icon: '📲', label: 'Cancel any time' },
  ],
  promises: [
    {
      icon: '🌅',
      title: 'Cooked fresh / flash-frozen',
      description:
        'Hot Indian meals cooked 5–8 AM and delivered hot; international bowls flash-frozen at their peak.',
    },
    {
      icon: '🧂',
      title: '5–7 ml oil / meal',
      description: 'Measured per plate. We weigh oil with a spoon, not a ladle.',
    },
    {
      icon: '🚫',
      title: 'Zero maida, zero MSG',
      description: 'No refined flour, no preservatives, no refined sugar.',
    },
    {
      icon: '🥬',
      title: 'UAE-sourced produce',
      description: 'Vegetables sourced from UAE farms 4 days a week.',
    },
    {
      icon: '🥩',
      title: 'Halal-certified protein',
      description: 'Halal-certified suppliers. Certificate on request.',
    },
    {
      icon: '📦',
      title: 'Eco packaging',
      description: 'Bagasse containers — compostable in 90 days.',
    },
  ],
  howItWorks: [
    {
      step: '01',
      icon: '📝',
      title: 'Take the 60-sec quiz',
      description:
        'Tell us your goal, height, weight, allergies and favourite cuisines. Our dietitian picks the right plan and portion size.',
    },
    {
      step: '02',
      icon: '💬',
      title: 'Confirm on WhatsApp',
      description:
        'We send your menu and price to WhatsApp — and your first day is on us when you start. Pay by card link, bank transfer or cash on first delivery.',
    },
    {
      step: '03',
      icon: '👨‍🍳',
      title: 'We cook & pack',
      description:
        'Hot Indian meals are cooked fresh from 5–8 AM in our Business Bay kitchen; international bowls are flash-frozen at peak freshness.',
    },
    {
      step: '04',
      icon: '🛵',
      title: 'Delivered to your door',
      description:
        'Hot meals hand-delivered hot in 30 minutes across Business Bay, DIFC, Downtown, Marina & JLT — our own driver, never a third-party rider.',
    },
  ],
  nav: [
    { label: 'Plans', href: '/plans' },
    { label: 'Menu', href: '/menu' },
    { label: 'Pricing', href: '/pricing' },
    { label: 'How it works', href: '/#how-it-works' },
  ],
} as const

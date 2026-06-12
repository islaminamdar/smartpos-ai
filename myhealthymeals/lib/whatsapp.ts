import { siteConfig } from './site'

export type LeadFormData = {
  name: string
  phone: string
  nationality: string
  diet: string
  area: string
  goal: string
  currentService: string
  allergies: string
}

export type QuizData = {
  goal: string
  height: string
  weight: string
  diet: string
  cuisines: string[]
  allergies: string
  area: string
  phone: string
  name: string
}

const AREAS = [
  'Business Bay',
  'Downtown Dubai',
  'DIFC',
  'Dubai Marina',
  'JLT',
  'JBR (Jumeirah Beach Residence)',
  'The Greens / The Views',
  'Palm Jumeirah',
  'Al Barsha',
  'Dubai Hills Estate',
  'Other (please advise)',
]

const GOALS = [
  'Lose weight',
  'Build muscle',
  'Manage diabetes',
  'Eat clean / save time',
  'Family meals',
]

export { AREAS, GOALS }

export function buildWhatsAppUrl(message: string): string {
  const encoded = encodeURIComponent(message)
  return `https://wa.me/${siteConfig.whatsapp}?text=${encoded}`
}

export function buildLeadMessage(data: LeadFormData): string {
  return [
    "Hi MyHealthyMeals! I'd like to start a plan.",
    '',
    `Name: ${data.name}`,
    `WhatsApp: ${data.phone}`,
    `Nationality: ${data.nationality}`,
    `Diet: ${data.diet}`,
    `Area: ${data.area}`,
    `Goal: ${data.goal}`,
    `On another meal service: ${data.currentService}`,
    data.allergies ? `Allergies: ${data.allergies}` : '',
    '',
    "I'd like to claim my free first day.",
  ]
    .filter(Boolean)
    .join('\n')
}

export function buildQuizMessage(data: QuizData): string {
  return [
    'Hi MyHealthyMeals! I completed the quiz.',
    '',
    `Name: ${data.name}`,
    `WhatsApp: ${data.phone}`,
    `Goal: ${data.goal}`,
    `Height: ${data.height} cm`,
    `Weight: ${data.weight} kg`,
    `Diet: ${data.diet}`,
    `Favourite cuisines: ${data.cuisines.join(', ') || 'No preference'}`,
    `Area: ${data.area}`,
    data.allergies ? `Allergies: ${data.allergies}` : '',
    '',
    "Please recommend a plan for me. I'd like to claim my free first day.",
  ]
    .filter(Boolean)
    .join('\n')
}

export function recommendPlan(goal: string): string {
  const map: Record<string, string> = {
    'Lose weight': 'Weight Loss',
    'Build muscle': 'High Protein',
    'Manage diabetes': 'Diabetic-Friendly',
    'Eat clean / save time': 'Lean & Balanced',
    'Family meals': 'Family Plan',
  }
  return map[goal] ?? 'Lean & Balanced'
}

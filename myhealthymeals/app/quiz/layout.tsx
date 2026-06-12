import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Find Your Plan — 60-Second Quiz',
  description:
    'Take our 60-second quiz to find the right dietitian-designed meal plan for your goal. First day on us.',
}

export default function QuizLayout({ children }: { children: React.ReactNode }) {
  return children
}

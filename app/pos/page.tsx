import type { Metadata } from 'next'
import PosWorkspace from '@/components/pos/PosWorkspace'
import './pos.css'

export const metadata: Metadata = {
  title: 'Counter · Internext POS',
  description: 'Internext restaurant POS workspace. Local training preview.',
  robots: { index: false, follow: false },
  manifest: '/pos.webmanifest',
}

export default function PosPage() {
  return <PosWorkspace />
}

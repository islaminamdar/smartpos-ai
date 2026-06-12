'use client'

import { useEffect, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function MobileCTA() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 400)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 border-t border-surface-200 bg-white/95 p-4 backdrop-blur-md transition-transform duration-300 lg:hidden',
        visible ? 'translate-y-0' : 'translate-y-full'
      )}
    >
      <Button href="/quiz" className="w-full" size="lg">
        Take the 60-sec quiz
        <ArrowRight className="h-4 w-4" />
      </Button>
    </div>
  )
}

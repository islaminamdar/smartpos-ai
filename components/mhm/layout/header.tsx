'use client'

import Link from 'next/link'
import { Menu, MessageCircle, X } from 'lucide-react'
import { useState } from 'react'
import { siteConfig } from '@/lib/mhm/site'
import { buildWhatsAppUrl } from '@/lib/mhm/whatsapp'
import { Button } from '@/components/mhm/ui/button'
import { cn } from '@/lib/utils'

export function Header() {
  const [open, setOpen] = useState(false)
  const whatsappUrl = buildWhatsAppUrl("Hi! I'd like to learn more about MyHealthyMeals.")

  return (
    <header className="sticky top-0 z-50 border-b border-surface-200/80 bg-white/90 backdrop-blur-md">
      <div className="container-main flex h-16 items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-500 text-sm font-bold text-white">
            M
          </span>
          <span className="text-lg font-bold tracking-tight text-surface-900">
            {siteConfig.name}
          </span>
        </Link>

        <nav className="hidden items-center gap-8 lg:flex">
          {siteConfig.nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-sm font-medium text-surface-600 transition-colors hover:text-brand-600"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-3 lg:flex">
          <Button href={whatsappUrl} variant="ghost" size="sm" external>
            <MessageCircle className="h-4 w-4" />
            WhatsApp
          </Button>
          <Button href="/quiz" size="sm">
            Take quiz
          </Button>
        </div>

        <button
          type="button"
          className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-surface-200 lg:hidden"
          onClick={() => setOpen(!open)}
          aria-label={open ? 'Close menu' : 'Open menu'}
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      <div
        className={cn(
          'overflow-hidden border-t border-surface-200 bg-white transition-all duration-300 lg:hidden',
          open ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'
        )}
      >
        <nav className="container-main flex flex-col gap-1 py-4">
          {siteConfig.nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-xl px-4 py-3 text-sm font-medium text-surface-700 hover:bg-surface-50"
              onClick={() => setOpen(false)}
            >
              {item.label}
            </Link>
          ))}
          <div className="mt-2 flex flex-col gap-2 px-4">
            <Button href="/quiz" className="w-full">
              Take quiz
            </Button>
            <Button href={whatsappUrl} variant="secondary" className="w-full" external>
              <MessageCircle className="h-4 w-4" />
              WhatsApp us
            </Button>
          </div>
        </nav>
      </div>
    </header>
  )
}

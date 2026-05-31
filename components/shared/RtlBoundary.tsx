'use client'
import { rtlLocales, type Locale } from '@/lib/i18n/config'

export function RtlBoundary({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return <div dir={rtlLocales.has(locale) ? 'rtl' : 'ltr'}>{children}</div>
}

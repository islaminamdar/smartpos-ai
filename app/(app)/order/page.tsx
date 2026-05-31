'use client'
import { useState } from 'react'
import { VoicePad } from '@/components/order/VoicePad'
import { OrderCart } from '@/components/order/OrderCart'
import { LanguagePicker } from '@/components/order/LanguagePicker'

export default function OrderPage() {
  const [locale, setLocale] = useState('en')
  const [parsed, setParsed] = useState<any | null>(null)

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Voice Order</h1>
        <LanguagePicker value={locale} onChange={setLocale} />
      </header>
      <VoicePad locale={locale} onResult={(_id, p) => setParsed(p)} />
      <OrderCart parsed={parsed} />
    </main>
  )
}

import Link from 'next/link'
import { Button } from '@/components/ui/button'

export default function Landing() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-16 px-6 py-12">
      <header className="flex items-center justify-between">
        <span className="text-xl font-semibold tracking-tight">
          SmartPOS<span className="text-violet-600">.ai</span>
        </span>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/login">Sign in</Link>
          <Link
            href="/signup"
            className="inline-flex items-center justify-center rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700"
          >
            Start free trial
          </Link>
        </nav>
      </header>
      <section className="space-y-6 text-center">
        <h1 className="text-5xl font-semibold tracking-tight md:text-6xl">
          The AI POS for UAE restaurants.
        </h1>
        <p className="mx-auto max-w-2xl text-lg text-muted-foreground">
          Voice orders in five languages. WhatsApp concierge. An owner dashboard you can talk to.
          100 AED / month.
        </p>
        <Link
          href="/signup"
          className="inline-flex items-center justify-center rounded-full bg-violet-600 px-6 py-3 text-lg font-medium text-white hover:bg-violet-700"
        >
          Start 14-day free trial →
        </Link>
      </section>
      <section className="grid gap-4 md:grid-cols-3">
        <Feature
          title="Voice orders"
          body="Tap, speak in any language, ticket prints in the kitchen."
        />
        <Feature
          title="WhatsApp concierge"
          body="Customers chat your restaurant's WhatsApp; AI handles 80%."
        />
        <Feature
          title="Ask your dashboard"
          body='"How did Friday go?" — natural-language answers from your data.'
        />
      </section>
    </main>
  )
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border bg-white/60 p-6 backdrop-blur dark:bg-neutral-950/60">
      <h3 className="mb-2 text-lg font-semibold">{title}</h3>
      <p className="text-sm text-muted-foreground">{body}</p>
    </div>
  )
}

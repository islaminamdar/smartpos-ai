import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function DoneStep() {
  return (
    <section className="space-y-4 text-center">
      <h2 className="text-3xl font-semibold">You&apos;re live.</h2>
      <p className="text-muted-foreground">
        Take a voice order to see your kitchen ticket print and your dashboard light up.
      </p>
      <div className="flex justify-center gap-2">
        <Link href="/order" className={cn(buttonVariants({ variant: 'default' }))}>
          Open Voice Order
        </Link>
        <Link href="/dashboard" className={cn(buttonVariants({ variant: 'outline' }))}>
          Open Dashboard
        </Link>
      </div>
    </section>
  )
}

import { cn } from '@/lib/utils'

type SectionProps = {
  id?: string
  className?: string
  children: React.ReactNode
  background?: 'white' | 'muted' | 'brand'
}

const backgrounds = {
  white: 'bg-white',
  muted: 'bg-surface-50',
  brand: 'bg-brand-50',
}

export function Section({ id, className, children, background = 'white' }: SectionProps) {
  return (
    <section id={id} className={cn('section', backgrounds[background], className)}>
      <div className="container-main">{children}</div>
    </section>
  )
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  align = 'center',
  className,
}: {
  eyebrow?: string
  title: string
  description?: string
  align?: 'left' | 'center'
  className?: string
}) {
  return (
    <div
      className={cn(
        'mb-12 md:mb-16',
        align === 'center' && 'mx-auto max-w-3xl text-center',
        className
      )}
    >
      {eyebrow && <p className="badge mb-4">{eyebrow}</p>}
      <h2 className="section-heading">{title}</h2>
      {description && <p className="section-subheading mx-auto">{description}</p>}
    </div>
  )
}

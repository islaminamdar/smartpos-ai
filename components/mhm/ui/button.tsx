import Link from 'next/link'
import { cn } from '@/lib/utils'

type ButtonProps = {
  href?: string
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  className?: string
  children: React.ReactNode
  external?: boolean
} & React.ButtonHTMLAttributes<HTMLButtonElement>

const variants = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
}

const sizes = {
  sm: 'px-4 py-2 text-xs',
  md: 'px-5 py-2.5 text-sm',
  lg: 'px-7 py-3.5 text-base',
}

export function Button({
  href,
  variant = 'primary',
  size = 'md',
  className,
  children,
  external,
  ...props
}: ButtonProps) {
  const classes = cn(variants[variant], sizes[size], className)

  if (href) {
    if (external) {
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className={classes}>
          {children}
        </a>
      )
    }
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    )
  }

  return (
    <button className={classes} {...props}>
      {children}
    </button>
  )
}

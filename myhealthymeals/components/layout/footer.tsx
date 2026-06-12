import Link from 'next/link'
import { siteConfig } from '@/lib/site'

const footerLinks = {
  Plans: [
    { label: 'Weight Loss', href: '/plans#weight-loss' },
    { label: 'High Protein', href: '/plans#high-protein' },
    { label: 'Diabetic-Friendly', href: '/plans#diabetic-friendly' },
    { label: 'Family Plan', href: '/plans#family' },
  ],
  Company: [
    { label: 'How it works', href: '/#how-it-works' },
    { label: 'Pricing', href: '/pricing' },
    { label: 'Menu', href: '/menu' },
    { label: 'Take quiz', href: '/quiz' },
  ],
}

export function Footer() {
  return (
    <footer className="border-t border-surface-200 bg-surface-900 text-surface-300">
      <div className="container-main py-16">
        <div className="grid gap-12 md:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-500 text-sm font-bold text-white">
                M
              </span>
              <span className="text-lg font-bold text-white">{siteConfig.name}</span>
            </div>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-surface-400">
              Dietitian-portioned, halal-certified meals cooked fresh in Business Bay. Delivered to
              Business Bay, DIFC, Downtown, Marina &amp; JLT.
            </p>
            <p className="mt-4 text-sm text-brand-400">From AED 22 / meal · First day on us</p>
          </div>

          {Object.entries(footerLinks).map(([title, links]) => (
            <div key={title}>
              <h3 className="text-sm font-semibold text-white">{title}</h3>
              <ul className="mt-4 space-y-3">
                {links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-sm text-surface-400 transition-colors hover:text-white"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-surface-800 pt-8 text-sm text-surface-500 md:flex-row">
          <p>
            © {new Date().getFullYear()} {siteConfig.name}. All rights reserved.
          </p>
          <p>Halal certified · Dubai Municipality licensed</p>
        </div>
      </div>
    </footer>
  )
}

import { siteConfig } from '@/lib/mhm/site'

export function TrustBar() {
  const items = [
    'Halal Certified Suppliers',
    'Business Bay Kitchen',
    'Fresh-Cooked or Flash-Frozen',
    'Own-Driver Delivery',
  ]

  return (
    <section className="border-b border-surface-100 bg-surface-50 py-6">
      <div className="container-main">
        <p className="mb-4 text-center text-xs font-semibold uppercase tracking-wider text-surface-500">
          What we promise on every delivery
        </p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {items.map((item) => (
            <div
              key={item}
              className="flex items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 text-center text-xs font-medium text-surface-700 shadow-sm md:text-sm"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
              {item}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

export function PromiseGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {siteConfig.promises.map((promise) => (
        <div key={promise.title} className="card-hover">
          <span className="text-2xl">{promise.icon}</span>
          <h3 className="mt-3 font-semibold text-surface-900">{promise.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-surface-500">{promise.description}</p>
        </div>
      ))}
    </div>
  )
}

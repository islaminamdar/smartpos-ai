import { audiences } from '@/lib/mhm/plans'

export function AudienceGrid() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {audiences.map((item) => (
        <div key={item.title} className="card-hover">
          <span className="text-2xl">{item.emoji}</span>
          <h3 className="mt-3 font-semibold text-surface-900">{item.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-surface-500">{item.description}</p>
        </div>
      ))}
    </div>
  )
}

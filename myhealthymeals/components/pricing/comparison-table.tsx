import { Check, X, Minus } from 'lucide-react'
import { comparisonRows } from '@/lib/pricing'

function CellValue({ value }: { value: boolean | string }) {
  if (value === true) return <Check className="mx-auto h-5 w-5 text-brand-500" />
  if (value === false) return <X className="mx-auto h-5 w-5 text-surface-300" />
  if (value === '—') return <Minus className="mx-auto h-5 w-5 text-surface-300" />
  return <span className="text-sm text-surface-600">{value}</span>
}

export function ComparisonTable() {
  return (
    <div className="overflow-x-auto rounded-2xl border border-surface-200 bg-white">
      <table className="w-full min-w-[600px] text-left">
        <thead>
          <tr className="border-b border-surface-200 bg-surface-50">
            <th className="px-6 py-4 text-sm font-semibold text-surface-900">Feature</th>
            <th className="px-6 py-4 text-center text-sm font-semibold text-brand-600">
              MyHealthyMeals
            </th>
            <th className="px-6 py-4 text-center text-sm font-semibold text-surface-600">
              Delivery apps
            </th>
            <th className="px-6 py-4 text-center text-sm font-semibold text-surface-600">
              Cooking at home
            </th>
          </tr>
        </thead>
        <tbody>
          {comparisonRows.map((row) => (
            <tr key={row.feature} className="border-b border-surface-100 last:border-0">
              <td className="px-6 py-4 text-sm text-surface-700">{row.feature}</td>
              <td className="px-6 py-4 text-center">
                <CellValue value={row.us} />
              </td>
              <td className="px-6 py-4 text-center">
                <CellValue value={row.apps} />
              </td>
              <td className="px-6 py-4 text-center">
                <CellValue value={row.home} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

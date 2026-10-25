'use client'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  branchReportSchema,
  dubaiToday,
  reportQuerySchema,
  type BranchReport,
} from '@/lib/pos/reports/contracts'
import { formatFils } from '@/lib/pos/money'
import styles from './reports.module.css'
const money = (value: number) => formatFils(value)
const quantity = (value: number) =>
  new Intl.NumberFormat('en-AE', { maximumFractionDigits: 3 }).format(value / 1000)
export const reportPresets = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['this_week', 'This week'],
  ['last_week', 'Last week'],
  ['this_month', 'This month'],
  ['last_month', 'Last month'],
] as const

export type ReportPreset = (typeof reportPresets)[number][0]

const isoDate = (date: Date) => date.toISOString().slice(0, 10)
const dateAtUtcMidnight = (value: string) => new Date(`${value}T00:00:00.000Z`)
const addDays = (value: string, days: number) => {
  const date = dateAtUtcMidnight(value)
  date.setUTCDate(date.getUTCDate() + days)
  return isoDate(date)
}

/** Calendar ranges are based on the current Dubai calendar date, never the browser's timezone. */
export function rangeForReportPreset(preset: ReportPreset, today = dubaiToday()) {
  const date = dateAtUtcMidnight(today)
  if (preset === 'today') return { start: today, end: today }
  if (preset === 'yesterday') {
    const yesterday = addDays(today, -1)
    return { start: yesterday, end: yesterday }
  }
  if (preset === 'this_week' || preset === 'last_week') {
    // getUTCDay is used only for calendar arithmetic after anchoring the Dubai date above.
    const mondayOffset = (date.getUTCDay() + 6) % 7
    const thisMonday = addDays(today, -mondayOffset)
    if (preset === 'this_week') return { start: thisMonday, end: today }
    const lastMonday = addDays(thisMonday, -7)
    return { start: lastMonday, end: addDays(lastMonday, 6) }
  }
  if (preset === 'this_month') return { start: `${today.slice(0, 7)}-01`, end: today }
  const firstThisMonth = dateAtUtcMidnight(`${today.slice(0, 7)}-01`)
  firstThisMonth.setUTCMonth(firstThisMonth.getUTCMonth() - 1)
  const start = isoDate(firstThisMonth)
  return { start, end: addDays(`${today.slice(0, 7)}-01`, -1) }
}

const errors: Record<string, string> = {
  report_manager_required: 'Only a manager or owner can view this branch report.',
  invalid_report_range:
    'Choose valid dates, no more than 93 days apart including the first and last day.',
  report_range_too_large: 'This report contains too many records. Choose a shorter date range.',
  report_profile_required: 'This branch needs its receipt profile before reports are available.',
}
export default function BranchReports({
  branchId,
  branchName,
}: {
  branchId: string
  branchName: string
}) {
  const [start, setStart] = useState(dubaiToday),
    [end, setEnd] = useState(dubaiToday)
  const [report, setReport] = useState<BranchReport | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [search, setSearch] = useState('')
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null)
  useEffect(() => {
    generation.current++
    controller.current?.abort()
    setReport(null)
    setError('')
    setLoading(false)
    setSearch('')
    return () => {
      generation.current++
      controller.current?.abort()
    }
  }, [branchId])
  async function loadRange(nextStart: string, nextEnd: string) {
    const query = reportQuerySchema.safeParse({ branchId, start: nextStart, end: nextEnd })
    if (!query.success) {
      setError(errors.invalid_report_range)
      return
    }
    controller.current?.abort()
    controller.current = new AbortController()
    const current = ++generation.current
    setLoading(true)
    setError('')
    setReport(null)
    try {
      const response = await fetch(
        '/api/pos/reports?' + new URLSearchParams({ branchId, start: nextStart, end: nextEnd }),
        {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.any([controller.current.signal, AbortSignal.timeout(30000)]),
        }
      )
      const data: unknown = await response.json()
      if (!response.ok) {
        const code = data && typeof data === 'object' && 'code' in data ? String(data.code) : ''
        throw new Error(
          response.status === 401
            ? 'Your session expired. Sign in again before loading reports.'
            : (errors[code] ??
                'The report could not be loaded. Check your connection and try again. No totals are available yet.')
        )
      }
      const verified = branchReportSchema.parse(data)
      if (
        verified.branchId !== branchId ||
        verified.startDate !== nextStart ||
        verified.endDate !== nextEnd
      )
        throw new Error('The report did not match the selected branch and dates. Please reload it.')
      if (current === generation.current) setReport(verified)
    } catch (cause) {
      if (current === generation.current)
        setError(
          cause !== null &&
            typeof cause === 'object' &&
            'name' in cause &&
            cause.name === 'TimeoutError'
            ? 'The report took too long to load. Check your connection and try again; no totals are available yet.'
            : cause instanceof Error && cause.name !== 'ZodError'
              ? cause.message
              : 'The report could not be verified. Please try again; no totals are available.'
        )
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }
  async function load(event: FormEvent) {
    event.preventDefault()
    await loadRange(start, end)
  }
  function applyPreset(preset: ReportPreset) {
    const range = rangeForReportPreset(preset)
    setStart(range.start)
    setEnd(range.end)
    void loadRange(range.start, range.end)
  }
  const current =
    report?.branchId === branchId && report.startDate === start && report.endDate === end
      ? report
      : null
  const products =
    current?.products.filter((item) =>
      item.name.toLowerCase().includes(search.toLowerCase().trim())
    ) ?? []
  const topProducts = useMemo(() => {
    if (!current) return []
    return [...current.products]
      .sort(
        (left, right) =>
          right.netGrossFils - left.netGrossFils ||
          right.netQuantityMilli - left.netQuantityMilli ||
          left.name.localeCompare(right.name, 'en') ||
          left.productId.localeCompare(right.productId)
      )
      .slice(0, 10)
  }, [current])
  return (
    <section className={styles.reports} aria-label="Branch reports">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Branch reporting</p>
          <h2>{branchName}</h2>
          <p>Sales, recorded payments and VAT from issued invoices and credit notes.</p>
        </div>
      </header>
      <form onSubmit={load} className={styles.filters}>
        <label>
          From
          <input
            type="date"
            value={start}
            onChange={(event) => setStart(event.target.value)}
            required
            disabled={loading}
          />
        </label>
        <label>
          Through
          <input
            type="date"
            value={end}
            onChange={(event) => setEnd(event.target.value)}
            required
            disabled={loading}
          />
        </label>
        <button type="submit" disabled={loading}>
          {loading ? 'Loading report…' : 'Load report'}
        </button>
      </form>
      <div className={styles.presets} aria-label="Quick date ranges">
        {reportPresets.map(([preset, label]) => (
          <button
            key={preset}
            type="button"
            className={styles.secondary}
            disabled={loading}
            onClick={() => applyPreset(preset)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className={styles.help}>
        Quick ranges load immediately. Dates include the whole day in Dubai (UTC+4); weeks run
        Monday through Sunday and ranges can be up to 93 days.
      </p>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {!current && !loading && !error && (
        <p className={styles.empty}>
          Choose your dates and load the report. An unavailable report is never shown as zero sales.
        </p>
      )}
      {loading && <p role="status">Reading the saved financial records…</p>}
      {current && (
        <>
          <div className={styles.reportMeta}>
            <p>
              {current.startDate} through {current.endDate} · AED · Updated{' '}
              {new Date(current.generatedAt).toLocaleString('en-AE', { timeZone: 'Asia/Dubai' })}{' '}
              Dubai time
            </p>
            <a
              href={
                '/api/pos/reports?' +
                new URLSearchParams({
                  branchId,
                  start: current.startDate,
                  end: current.endDate,
                  format: 'csv',
                })
              }
            >
              Export CSV
            </a>
          </div>
          {current.legacyOrdersExcluded > 0 && (
            <p className={styles.warning}>
              {current.legacyOrdersExcluded} older order(s) received in this date range have no
              issued fiscal invoice and are excluded. Review those records separately.
            </p>
          )}
          <div className={styles.summary}>
            <article>
              <span>Sales including VAT</span>
              <strong>{money(current.summary.salesGrossFils)}</strong>
              <small>{current.summary.invoiceCount} invoices</small>
            </article>
            <article>
              <span>Refunds including VAT</span>
              <strong>{money(current.summary.refundGrossFils)}</strong>
              <small>{current.summary.creditNoteCount} credit notes</small>
            </article>
            <article>
              <span>Net including VAT</span>
              <strong>{money(current.summary.netGrossFils)}</strong>
              <small>Sales less credit notes</small>
            </article>
            <article>
              <span>Net excluding VAT</span>
              <strong>{money(current.summary.netExVatFils)}</strong>
              <small>After credit notes</small>
            </article>
            <article>
              <span>Net VAT</span>
              <strong>{money(current.summary.vatFils)}</strong>
              <small>As recorded on documents</small>
            </article>
          </div>
          {current.documentCount === 0 && (
            <p className={styles.empty}>
              No invoices or credit notes were issued in this date range.
            </p>
          )}
          <p className={styles.notice}>
            Credit notes reduce the day they were issued, even when the original sale was earlier.
            Cash payments exclude change and drawer movements. Card figures record payments taken on
            an external terminal; they do not confirm bank settlement.
          </p>
          <ReportTable
            title="By day"
            headers={[
              'Dubai date',
              'Invoices',
              'Credits',
              'Sales incl. VAT',
              'Refunds incl. VAT',
              'Net incl. VAT',
              'Net VAT',
            ]}
            rows={current.days.map((day) => [
              day.date,
              String(day.invoiceCount),
              String(day.creditNoteCount),
              money(day.salesGrossFils),
              money(day.refundGrossFils),
              money(day.netGrossFils),
              money(day.vatFils),
            ])}
          />
          <div className={styles.twoColumns}>
            <ReportTable
              title="Recorded payments"
              headers={['Method', 'Sales', 'Refunds', 'Net']}
              rows={current.payments.map((payment) => [
                payment.method === 'cash'
                  ? 'Cash'
                  : payment.method === 'bank_transfer'
                    ? 'Bank transfer'
                    : 'Recorded card',
                money(payment.salesFils),
                money(payment.refundsFils),
                money(payment.netFils),
              ])}
            />
            <ReportTable
              title="VAT by rate"
              headers={['Rate', 'Net excl. VAT', 'Net VAT', 'Net incl. VAT']}
              rows={current.vatRates.map((rate) => [
                `${rate.taxRateBps / 100}%`,
                money(rate.netExVatFils),
                money(rate.vatFils),
                money(rate.netGrossFils),
              ])}
            />
          </div>
          <ReportTable
            title="Top products by net sales"
            headers={['Rank', 'Product', 'Unit', 'Net sold', 'Net incl. VAT']}
            rows={topProducts.map((product, index) => [
              String(index + 1),
              product.name,
              product.unit,
              quantity(product.netQuantityMilli),
              money(product.netGrossFils),
            ])}
          />
          <p className={styles.help}>
            Ranked from issued invoices less credit notes in this date range. Product categories are
            not ranked yet because older fiscal snapshots do not preserve the category at the time
            of sale.
          </p>
          <div className={styles.productsHeader}>
            <h3>Product totals</h3>
            <label>
              Find a product
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search saved product names"
              />
            </label>
          </div>
          <p className={styles.help}>
            Historical names and units are preserved. A renamed item can appear on more than one
            row.
          </p>
          <ReportTable
            title="Sold and refunded products"
            headers={[
              'Product',
              'Unit',
              'Sold',
              'Refunded',
              'Net quantity',
              'Net incl. VAT',
              'Net VAT',
            ]}
            rows={products.map((product) => [
              product.name,
              product.unit,
              quantity(product.soldQuantityMilli),
              quantity(product.refundedQuantityMilli),
              quantity(product.netQuantityMilli),
              money(product.netGrossFils),
              money(product.vatFils),
            ])}
          />
          <p className={styles.help}>
            This operational report covers issued fiscal documents. It is not a VAT return or a
            payment-provider settlement statement.
          </p>
        </>
      )}
    </section>
  )
}
function ReportTable({
  title,
  headers,
  rows,
}: {
  title: string
  headers: string[]
  rows: string[][]
}) {
  return (
    <section className={styles.tableSection}>
      <h3>{title}</h3>
      <div className={styles.tableScroll} role="region" aria-label={title} tabIndex={0}>
        <table>
          <thead>
            <tr>
              {headers.map((header) => (
                <th key={header} scope="col">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, column) => (
                    <td key={column}>{cell}</td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={headers.length}>No records in this report.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

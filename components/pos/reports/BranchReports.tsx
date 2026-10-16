'use client'
import { useEffect, useRef, useState, type FormEvent } from 'react'
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
  async function load(event: FormEvent) {
    event.preventDefault()
    const query = reportQuerySchema.safeParse({ branchId, start, end })
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
        '/api/pos/reports?' + new URLSearchParams({ branchId, start, end }),
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
        verified.startDate !== start ||
        verified.endDate !== end
      )
        throw new Error('The report did not match the selected branch and dates. Please reload it.')
      if (current === generation.current) setReport(verified)
    } catch (cause) {
      if (current === generation.current)
        setError(
          cause instanceof Error && cause.name !== 'ZodError'
            ? cause.message
            : 'The report could not be verified. Please try again; no totals are available.'
        )
    } finally {
      if (current === generation.current) setLoading(false)
    }
  }
  const current =
    report?.branchId === branchId && report.startDate === start && report.endDate === end
      ? report
      : null
  const products =
    current?.products.filter((item) =>
      item.name.toLowerCase().includes(search.toLowerCase().trim())
    ) ?? []
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
        <button
          type="button"
          className={styles.secondary}
          disabled={loading}
          onClick={() => {
            const today = dubaiToday()
            setStart(today)
            setEnd(today)
          }}
        >
          Today
        </button>
      </form>
      <p className={styles.help}>
        Dates include the whole day in Dubai (UTC+4). Select up to 93 days.
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
                payment.method === 'cash' ? 'Cash' : 'Recorded card',
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

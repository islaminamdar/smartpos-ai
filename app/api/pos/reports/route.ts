import { NextResponse } from 'next/server'
import { authenticatedPosClient, PosServerError } from '@/lib/pos/server/client'
import { requirePilot } from '@/lib/pos/server/live-access'
import { posFailure, privateHeaders } from '@/lib/pos/server/http'
import { branchReportSchema, reportQuerySchema } from '@/lib/pos/reports/contracts'
import { reportCsv } from '@/lib/pos/reports/export'
export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  try {
    requirePilot()
    const parsed = reportQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams)
    )
    if (!parsed.success) throw new PosServerError('invalid_report_range', 422)
    const query = parsed.data
    const { client } = await authenticatedPosClient()
    const { data, error } = await client.rpc('pos_branch_report', {
      p_branch: query.branchId,
      p_start: query.start,
      p_end: query.end,
    })
    if (error) {
      const codes: Record<string, [string, number]> = {
        POS_REPORT_ACCESS_DENIED: ['report_manager_required', 403],
        POS_REPORT_INVALID_RANGE: ['invalid_report_range', 422],
        POS_REPORT_PROFILE_REQUIRED: ['report_profile_required', 409],
        POS_REPORT_TOO_LARGE: ['report_range_too_large', 422],
      }
      const found = Object.entries(codes).find(([code]) => error.message.includes(code))?.[1]
      throw new PosServerError(found?.[0] ?? 'report_unavailable', found?.[1] ?? 503)
    }
    const report = branchReportSchema.parse(data)
    if (
      report.branchId !== query.branchId ||
      report.startDate !== query.start ||
      report.endDate !== query.end
    )
      throw new PosServerError('report_scope_mismatch', 503)
    if (query.format === 'csv')
      return new Response(reportCsv(report), {
        headers: {
          ...privateHeaders,
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="branch-report-${query.start}-to-${query.end}.csv"`,
          'X-Content-Type-Options': 'nosniff',
        },
      })
    return NextResponse.json(report, { headers: privateHeaders })
  } catch (error) {
    return posFailure(error)
  }
}

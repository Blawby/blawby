import { dashboardPresentation } from '~/shared/dashboard-presentation'
import { defineHandler, HTTPError } from 'nitro'
import { dashboardOrgQueryParam, readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { prepareInsightsIndex, insightsReader, insightsReviewEligibility } from '~/server/domain/insights'
import { paymentMonths, paymentMonthsQuery } from '~/server/domain/payments/earnings'
import { BATCH_VIEWER, roleAllows } from '~/server/utils/member-access'
import { roleMatchesSql, rolesAllowing } from '~/utils/organization-access'
import { paymentMoney } from '~/shared/payment-display'
import { jsonResponse } from '~/server/utils/api-response'

/** Menu cards share the session/membership snapshot; no media, Stripe or report-detail reads. */
export default defineHandler(async event => {
  const slug = dashboardOrgQueryParam(event)
  if (!slug) throw new HTTPError({ statusCode: 400, message: 'Organization is required', data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
  const month = new Date().toISOString().slice(0, 7), year = Number(month.slice(0, 4))
  const readsPayments = roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ payments: ['read'] }))
  const readsAnalytics = roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ analytics: ['read'] }))
  const scope = { sql: `CASE WHEN ${readsPayments} THEN ${BATCH_VIEWER.organization} END` }
  const insights = prepareInsightsIndex()
  const { organization, userId, rows } = await readDashboardMemberResources(event, { slug }, [paymentMonthsQuery(scope, year), ...insights.queries, {
    query: `SELECT COUNT(*) AS count, ROUND(AVG(r.rating), 2) AS rating FROM reviews r WHERE r.organization_id = CASE WHEN ${readsAnalytics} THEN ${BATCH_VIEWER.organization} END AND ${insightsReviewEligibility}`, params: [],
  }])
  const principal = { organizationId: organization.id, role: organization.role }
  const earningsAllowed = await roleAllows({ ...principal, permissions: { payments: ['read'] } })
  const insightsAllowed = await roleAllows({ ...principal, permissions: { analytics: ['read'] } })
  const index = insightsAllowed ? insights.read(await insightsReader(organization, userId), rows.slice(1, 1 + insights.queries.length)) : null
  const monthly = earningsAllowed ? paymentMonths(rows[0]!, year) : null
  const reviews = rows.at(-1)!.results[0] as { count: number; rating: number | null }
  const currency = monthly?.currencies[0] ?? organization.default_currency
  const total = monthly?.months.find(row => row.month === month)
  const amount = total ? total.paid - total.refunded : null
  return jsonResponse({
    title: 'Menu',
    presentation: dashboardPresentation,
    cards: [
      ...(amount !== null ? [{ id: 'earnings', title: 'Earnings', value: paymentMoney(amount, currency), detail: `Direct payments for ${new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`))}`, symbol: 'chart.bar.fill', bars: monthly!.months.map(row => row.paid - row.refunded), month, currency, amount }] : []),
      ...(index ? [{ id: 'insights', title: 'Insights', value: reviews.rating === null ? 'No ratings yet' : `★ ${reviews.rating.toFixed(2)}`, detail: `${reviews.count} ${reviews.count === 1 ? 'review' : 'reviews'}`, symbol: 'star.bubble.fill', bars: [] }] : []),
    ],
    insights: index,
  }, { headers: { 'cache-control': 'private, no-store' } })
})

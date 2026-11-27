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
  const paymentRows = rows[0]!.results as Array<{ currency: string }>
  const currencies = [...new Set(paymentRows.map(row => row.currency))]
  const monthly = earningsAllowed ? (currencies.length ? currencies : [organization.default_currency]).map(currency => ({
    currency, ...paymentMonths({ ...rows[0]!, results: paymentRows.filter(row => row.currency === currency) }, year),
  })) : []
  const reviews = rows.at(-1)!.results[0] as { count: number; rating: number | null }
  const totals = monthly.map(({ currency, months }) => {
    const total = months.find(row => row.month === month)!
    return { currency, amount: total.paid - total.refunded }
  })
  const single = totals.length === 1 ? totals[0]! : null
  return jsonResponse({
    title: 'Menu',
    presentation: dashboardPresentation,
    cards: [
      ...(totals.length ? [{ id: 'earnings', title: 'Earnings', value: totals.map(total => `${single ? '' : `${total.currency} `}${paymentMoney(total.amount, total.currency)}`).join(' · '), detail: `Direct payments for ${new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`))}`, symbol: 'chart.bar.fill', bars: single ? monthly[0]!.months.map(row => row.paid - row.refunded) : [], month, currency: single?.currency ?? null, amount: single?.amount ?? null, totals }] : []),
      ...(index ? [{ id: 'insights', title: 'Insights', value: reviews.rating === null ? 'No ratings yet' : `★ ${reviews.rating.toFixed(2)}`, detail: `${reviews.count} ${reviews.count === 1 ? 'review' : 'reviews'}`, symbol: 'star.bubble.fill', bars: [] }] : []),
    ],
    insights: index,
  }, { headers: { 'cache-control': 'private, no-store' } })
})

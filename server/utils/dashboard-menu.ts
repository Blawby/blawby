import { mediaPlacementsQuery } from '~/server/utils/media-asset-manager'
import { ownerPicturesFromRows } from '~/server/notifications/hero'
import { dashboardPresentation } from '~/shared/dashboard-presentation'
import type { BatchQuery } from '~/server/db'
import type { DashboardOrganizationRow } from '~/server/utils/dashboard-context'
import { prepareInsightsIndex, insightsReader, insightsReviewEligibility } from '~/server/domain/insights'
import { paymentMonths, paymentMonthsQuery } from '~/server/domain/payments/earnings'
import { BATCH_VIEWER, roleAllows } from '~/server/utils/member-access'
import { roleMatchesSql, rolesAllowing } from '~/utils/organization-access'
import { paymentMoney } from '~/shared/payment-display'


export function prepareDashboardMenu() {
  const month = new Date().toISOString().slice(0, 7), year = Number(month.slice(0, 4))
  const readsPayments = roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ payments: ['read'] }))
  const readsAnalytics = roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ analytics: ['read'] }))
  const scope = { sql: `CASE WHEN ${readsPayments} THEN ${BATCH_VIEWER.organization} END` }
  const insights = prepareInsightsIndex()
  const queries: BatchQuery[] = [paymentMonthsQuery(scope, year), ...insights.queries, {
    query: `SELECT COUNT(*) AS count, ROUND(AVG(r.rating), 2) AS rating FROM reviews r WHERE r.organization_id = CASE WHEN ${readsAnalytics} THEN ${BATCH_VIEWER.organization} END AND ${insightsReviewEligibility}`, params: [],
  }, mediaPlacementsQuery({ organizationId: { sql: `CASE WHEN ${readsAnalytics} THEN ${BATCH_VIEWER.organization} END` }, ownerType: 'product', includeOrganizationFallback: false,
    owners: { sql: `SELECT p.id FROM products p WHERE p.organization_id = ${BATCH_VIEWER.organization} AND p.active = 1 AND EXISTS (SELECT 1 FROM media_placements m WHERE m.organization_id = p.organization_id AND m.owner_type = 'product' AND m.owner_id = p.id AND m.status = 'active' AND m.slot IN ('image', 'gallery')) ORDER BY p.created_at, p.id LIMIT 3` },
  })]
  return { queries, async read(organization: DashboardOrganizationRow, userId: string, rows: D1Result[]) {
  const principal = { organizationId: organization.id, role: organization.role }
  const earningsAllowed = await roleAllows({ ...principal, permissions: { payments: ['read'] } })
  const insightsAllowed = await roleAllows({ ...principal, permissions: { analytics: ['read'] } })
  const index = insightsAllowed ? insights.read(await insightsReader(organization, userId), rows.slice(1, 1 + insights.queries.length)) : null
  const paymentRows = rows[0]!.results as Array<{ currency: string }>
  const currencies = [...new Set(paymentRows.map(row => row.currency))]
  const monthly = earningsAllowed ? (currencies.length ? currencies : [organization.default_currency]).map(currency => ({
    currency, ...paymentMonths({ ...rows[0]!, results: paymentRows.filter(row => row.currency === currency) }, year),
  })) : []
  const reviews = rows.at(-2)!.results[0] as { count: number; rating: number | null }
  const totals = monthly.map(({ currency, months }) => {
    const total = months.find(row => row.month === month)!
    return { currency, amount: total.paid - total.refunded }
  })
  const media = rows.at(-1)!.results as Array<{ owner_id: string }>
  const photos = [...ownerPicturesFromRows(organization.id, 'product', [...new Set(media.map(row => row.owner_id))], media, false).values()].flatMap(picture => picture ? [picture.imageUrl] : [])
  const single = totals.length === 1 ? totals[0]! : null
  return {
    title: 'Menu',
    presentation: dashboardPresentation,
    cards: [
      ...(totals.length ? [{ id: 'earnings', photos: [], title: 'Earnings', value: totals.map(total => `${single ? '' : `${total.currency} `}${paymentMoney(total.amount, total.currency)}`).join(' · '), detail: `Direct payments for ${new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`))}`, symbol: 'chart.bar.fill', bars: single ? monthly[0]!.months.map(row => row.paid - row.refunded) : [], month, currency: single?.currency ?? null, amount: single?.amount ?? null, totals }] : []),
      ...(index ? [{ id: 'insights', photos, title: 'Insights', value: reviews.rating === null ? 'No ratings yet' : `★ ${reviews.rating.toFixed(2)}`, detail: `${reviews.count} ${reviews.count === 1 ? 'review' : 'reviews'}`, symbol: 'star.bubble.fill', bars: [] }] : []),
    ],
    insights: index,
  }
  } }
}

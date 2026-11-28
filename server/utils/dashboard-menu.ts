import { HTTPError } from 'nitro'
import { canOpenPlatformAccounts, canOpenPlatformReports, hasPlatformAdminPermission } from '~/utils/platform-admin-access'
import { organizationFeaturesQuery, organizationFeaturesFromRow } from '~/server/utils/cms-capabilities'
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
import { offerDestination, offerSummary, planOffers } from '~/shared/offers'
import { prepareOrganizationPlan } from '~/server/utils/billing-access'
import { getPlanEntitlements } from '~/server/utils/billing-entitlements'


export function prepareDashboardMenu(native = false) {
  const month = new Date().toISOString().slice(0, 7), year = Number(month.slice(0, 4))
  const readsPayments = roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ payments: ['read'] }))
  const readsAnalytics = roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ analytics: ['read'] }))
  const scope = { sql: `CASE WHEN ${readsPayments} THEN ${BATCH_VIEWER.organization} END` }
  const insights = prepareInsightsIndex()
  const billing = prepareOrganizationPlan({ sql: BATCH_VIEWER.organization })
  const queries: BatchQuery[] = [paymentMonthsQuery(scope, year), ...insights.queries, {
    query: `SELECT COUNT(*) AS count, ROUND(AVG(r.rating), 2) AS rating FROM reviews r WHERE r.organization_id = CASE WHEN ${readsAnalytics} THEN ${BATCH_VIEWER.organization} END AND ${insightsReviewEligibility}`, params: [],
  }, mediaPlacementsQuery({ organizationId: { sql: `CASE WHEN ${readsAnalytics} THEN ${BATCH_VIEWER.organization} END` }, ownerType: 'product', includeOrganizationFallback: false,
    owners: { sql: `SELECT p.id FROM products p WHERE p.organization_id = ${BATCH_VIEWER.organization} AND p.active = 1 AND EXISTS (SELECT 1 FROM media_placements m WHERE m.organization_id = p.organization_id AND m.owner_type = 'product' AND m.owner_id = p.id AND m.status = 'active' AND m.slot IN ('image', 'gallery')) ORDER BY p.created_at, p.id LIMIT 3` },
  }), { query: `SELECT role FROM user WHERE id = ${BATCH_VIEWER.user}`, params: [] }, organizationFeaturesQuery({ sql: BATCH_VIEWER.organization }), billing.query]
  return { queries, async read(organization: DashboardOrganizationRow, userId: string, rows: D1Result[], options?: { origin: string; impersonated: boolean }) {
  const principal = { organizationId: organization.id, role: organization.role }
  const earningsAllowed = await roleAllows({ ...principal, permissions: { payments: ['read'] } })
  const insightsAllowed = await roleAllows({ ...principal, permissions: { analytics: ['read'] } })
  const index = insightsAllowed ? insights.read(await insightsReader(organization, userId), rows.slice(1, 1 + insights.queries.length)) : null
  const paymentRows = rows[0]!.results as Array<{ currency: string }>
  const currencies = [...new Set(paymentRows.map(row => row.currency))]
  const monthly = earningsAllowed ? (currencies.length ? currencies : [organization.default_currency]).map(currency => ({
    currency, ...paymentMonths({ ...rows[0]!, results: paymentRows.filter(row => row.currency === currency) }, year),
  })) : []
  const reviews = rows[1 + insights.queries.length]!.results[0] as { count: number; rating: number | null }
  const totals = monthly.map(({ currency, months }) => {
    const total = months.find(row => row.month === month)!
    return { currency, amount: total.paid - total.refunded }
  })
  const media = rows[2 + insights.queries.length]!.results as Array<{ owner_id: string }>
  const photos = [...ownerPicturesFromRows(organization.id, 'product', [...new Set(media.map(row => row.owner_id))], media, false).values()].flatMap(picture => picture ? [picture.imageUrl] : [])
  const single = totals.length === 1 ? totals[0]! : null
  const user = rows[3 + insights.queries.length]!.results[0] as { role: string | null } | undefined
  if (!user) throw new HTTPError({ statusCode: 409, message: 'The Menu viewer could not be read', data: { code: 'INVALID_MENU_CONTEXT', field: 'user' } })
  const features = organizationFeaturesFromRow(rows[4 + insights.queries.length]!.results[0] as Parameters<typeof organizationFeaturesFromRow>[0])
  const permissions = {
    payments: earningsAllowed, billing: await roleAllows({ ...principal, permissions: { billing: ['read'] } }),
    team: await roleAllows({ ...principal, permissions: { members: ['read'] } }), invite: await roleAllows({ ...principal, permissions: { members: ['invite'] } }),
  }
  const base = `/dashboard/${encodeURIComponent(organization.slug)}`
  const offered = await roleAllows({ ...principal, permissions: { billing: ['update'] } })
    ? planOffers(getPlanEntitlements(billing.read(rows.at(-1)!, organization.id)))[0] : null
  const promo = offered && 'plan' in offered.unlock ? { id: offered.id, headline: offered.headline, summary: offerSummary(offered),
    illustration: offered.illustration, to: offerDestination(offered, base) } : null
  const destination = (id: string, label: string, icon: string, native: string, to = `${base}/${id}`) => ({ id, label, icon, native, to })
  const navigation = [
    ...(await roleAllows({ ...principal, permissions: { content: ['read'] } }) ? [destination('website', 'Website', 'i-lucide-panels-top-left', 'website')] : []),
    ...(await roleAllows({ ...principal, permissions: { locations: ['read'] } }) || await roleAllows({ ...principal, permissions: { locations: ['assigned'] } })
      ? [destination('locations', organization.vertical === 'service' ? 'Offices' : 'Locations', 'i-lucide-map-pin', 'business-locations')] : []),
    ...(await roleAllows({ ...principal, permissions: { products: ['update'] } }) ? [destination('shipping', 'Shipping and pickup', 'i-lucide-truck', 'shipping')] : []),
    ...(permissions.team ? [destination('team', 'Team', 'i-lucide-users', 'team')] : []),
    ...(await roleAllows({ ...principal, permissions: { integrations: ['read'] } }) ? [destination('integrations', 'Connections', 'i-lucide-plug', 'connections')] : []),
    ...(permissions.billing ? [destination('billing', 'Plan and billing', 'i-lucide-receipt', 'billing')] : []),
    ...(canOpenPlatformAccounts(organization, user.role) ? [destination('platform-accounts', 'Platform accounts', 'i-lucide-shield-user', 'platform-accounts')] : []),
    ...(canOpenPlatformReports(organization, user.role) ? [destination('platform-reports', 'Platform reports', 'i-lucide-flag', 'platform-reports')] : []),
    destination('account', 'Account settings', 'i-lucide-user-round-cog', 'account', '/dashboard/account/profile'),
    ...native ? [
      { id: 'workspaces', label: 'Switch workspace', subtitle: organization.name, icon: 'i-lucide-repeat-2', native: 'workspaces', action: {} },
      { id: 'help', label: 'Help', icon: 'i-lucide-circle-help', native: 'help', external_url: new URL('/help', options!.origin).href },
      ...await roleAllows({ ...principal, permissions: { payments: ['integration'] } }) ? [destination('payments', 'Payments', 'i-lucide-credit-card', 'payments')] : [],
      ...hasPlatformAdminPermission(user.role, { user: ['impersonate'] }) && !options!.impersonated ? [{ id: 'support-access', label: 'Support access', icon: 'i-lucide-shield', native: 'support-access', action: {} }] : [],
    ] : [{ id: 'switch-personal', label: 'Switch to Personal', icon: 'i-lucide-repeat-2', native: 'switch-personal', action: {} }],
    { id: 'log-out', label: 'Log out', icon: 'i-lucide-log-out', native: 'sign-out', action: {} },
  ]
  const primary_action = features.includes('stays') && await roleAllows({ ...principal, permissions: { products: ['create'] } })
    ? { ...destination('add-listing', 'Create a new listing', 'i-lucide-plus', 'create-stay', `${base}/products/new?kind=stay&setup=guided`), detail: 'Host a home on Blawby.' } : null
  return {
    title: 'Menu', navigation, permissions, primary_action, promo,
    presentation: dashboardPresentation,
    cards: [
      ...(totals.length ? [{ id: 'earnings', photos: [], title: 'Earnings', value: totals.map(total => `${single ? '' : `${total.currency} `}${paymentMoney(total.amount, total.currency)}`).join(' · '), detail: `Direct payments for ${new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`))}`, symbol: 'chart.bar.fill', bars: single ? monthly[0]!.months.map(row => row.paid - row.refunded) : [], month, currency: single?.currency ?? null, amount: single?.amount ?? null, totals }] : []),
      ...(index ? [{ id: 'insights', photos, title: 'Insights', value: reviews.rating === null ? 'No ratings yet' : `★ ${reviews.rating.toFixed(2)}`, detail: `${reviews.count} ${reviews.count === 1 ? 'review' : 'reviews'}`, symbol: 'star.bubble.fill', bars: [] }] : []),
    ],
    insights: index,
  }
  } }
}

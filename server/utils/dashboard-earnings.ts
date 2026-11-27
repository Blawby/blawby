import { HTTPError, type H3Event } from 'nitro'
import { preparePaymentPerformance, readStripePayouts } from '~/server/domain/payments/earnings'
import { authorizePayments } from '~/server/domain/payments'
import { dashboardOrgQueryParam, readDashboardMemberResources, getDashboardContext } from '~/server/utils/dashboard-context'
import { BATCH_VIEWER, withViewer, roleAllows } from '~/server/utils/member-access'
import { roleMatchesSql, rolesAllowing } from '~/utils/organization-access'
import type { BatchQuery } from '~/server/db'
import { stripeConnectedAccountFromRow, stripeConnectedAccountQuery, type StripeConnectedAccount } from '~/server/utils/stripe-connect'
import { timeRequestPhase } from '~/server/utils/request-metrics'
import type { EarningsOverview, EarningsPerformance } from '~/shared/earnings-display'

export async function readDashboardEarnings(event: H3Event, query: { year?: unknown; month?: unknown; comparison?: unknown }, orgSlug?: string) {
  const slug = orgSlug ?? dashboardOrgQueryParam(event)
  if (!slug) throw new HTTPError({ statusCode: 400, message: 'Organization is required', data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
  if (query.comparison !== undefined && query.comparison !== 'previous_year') throw new HTTPError({ statusCode: 400, message: 'comparison must be previous_year', data: { code: 'INVALID_EARNINGS_PERIOD', field: 'comparison' } })
  const comparison = query.comparison === 'previous_year'
  const now = new Date()
  const year = Number(query.year ?? now.getUTCFullYear())
  const month = typeof query.month === 'string' ? query.month : now.toISOString().slice(0, 7)
  const preloaded = event.context.dashboardEarnings as { slug: string; periods: Map<string, EarningsPerformance> } | undefined
  const answer = preloaded?.slug === slug ? preloaded.periods.get(month) : undefined
  if (answer && Number(month.slice(0, 4)) === year && !comparison) {
    const { organization, userId } = await getDashboardContext(event, { organizationSlug: slug })
    await authorizePayments({ organizationId: organization.id, userId, role: organization.role }, 'read')
    return answer
  }
  const readsPayments = roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ payments: ['read'] }))
  const readsPayouts = roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ payments: ['payouts'] }))
  const plan = preparePaymentPerformance({ sql: `CASE WHEN ${readsPayments} THEN ${BATCH_VIEWER.organization} END` }, year, month, { sql: readsPayouts }, comparison)
  const { organization, userId, rows } = await readDashboardMemberResources(event, { slug }, plan.queries)
  await authorizePayments({ organizationId: organization.id, userId, role: organization.role }, 'read')
  return plan.read(rows, organization.id)
}

/** The Earnings landing page: its monthly summary and recent payouts share one D1 snapshot. */
export async function readDashboardEarningsOverview(event: H3Event, query: { year?: unknown; month?: unknown }): Promise<EarningsOverview> {
  const slug = dashboardOrgQueryParam(event)
  if (!slug) throw new HTTPError({ statusCode: 400, message: 'Organization is required', data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
  const now = new Date(), year = Number(query.year ?? now.getUTCFullYear()), month = typeof query.month === 'string' ? query.month : now.toISOString().slice(0, 7)
  const readsPayments = roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ payments: ['read'] }))
  const readsPayouts = roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ payments: ['payouts'] }))
  const scope = { sql: `CASE WHEN ${readsPayments} THEN ${BATCH_VIEWER.organization} END` }
  const plan = preparePaymentPerformance(scope, year, month, { sql: readsPayouts })
  const payout = stripeConnectedAccountQuery({ sql: `CASE WHEN ${readsPayouts} THEN ${scope.sql} END` })
  const { organization, userId, env, rows } = await readDashboardMemberResources(event, { slug }, [...plan.queries, payout])
  const principal = { organizationId: organization.id, userId, role: organization.role }
  await authorizePayments(principal, 'read')
  const performance = plan.read(rows.slice(0, plan.queries.length), organization.id)
  const canReadPayouts = await roleAllows({ ...principal, permissions: { payments: ['payouts'] } })
  return { month, performance, payouts: canReadPayouts ? await readStripePayouts(env, organization.id, stripeConnectedAccountFromRow(rows.at(-1)?.results[0])) : null }
}

export async function readDashboardPayoutAccount(event: H3Event) {
  const slug = dashboardOrgQueryParam(event)
  if (!slug) throw new HTTPError({ statusCode: 400, message: 'Organization is required', data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
  const allowed = roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ payments: ['payouts'] }))
  const query = stripeConnectedAccountQuery({ sql: `CASE WHEN ${allowed} THEN ${BATCH_VIEWER.organization} END` })
  const context = await readDashboardMemberResources(event, { slug }, [query])
  const principal = { organizationId: context.organization.id, userId: context.userId, role: context.organization.role }
  await authorizePayments(principal, 'read')
  await authorizePayments(principal, 'payouts')
  return { ...context, principal, account: stripeConnectedAccountFromRow(context.rows[0]?.results[0]) }
}

export async function readDashboardPayoutsDocument(event: H3Event, orgSlug: string, after?: unknown) {
  if (after !== undefined && (typeof after !== 'string' || !after)) throw new HTTPError({ statusCode: 400, statusMessage: 'Valid page cursor is required' })
  const { env, organization, userId } = await getDashboardContext(event, { organizationSlug: orgSlug })
  const principal = { organizationId: organization.id, userId, role: organization.role }
  await authorizePayments(principal, 'read')
  await authorizePayments(principal, 'payouts')
  const payout = event.context.dashboardPayoutAccount as { organizationId: string; account: StripeConnectedAccount | null } | undefined
  if (!payout || payout.organizationId !== organization.id) throw new HTTPError({ statusCode: 500, message: 'Earnings document is missing the Stripe account lookup' })
  return timeRequestPhase(event, 'stripe_payouts', () => readStripePayouts(env, organization.id, payout.account, after))
}

export function prepareDashboardEarningsDocument(membership: BatchQuery, months: ReadonlySet<string>, includePayouts: boolean) {
  const readsPayments = roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ payments: ['read'] }))
  const readsPayouts = roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ payments: ['payouts'] }))
  const organization = { sql: `CASE WHEN ${BATCH_VIEWER.organizationWide} = 1 AND ${readsPayments} THEN ${BATCH_VIEWER.organization} END` }
  const payout = includePayouts ? stripeConnectedAccountQuery({
    sql: `CASE WHEN ${readsPayouts} THEN ${organization.sql} END`,
  }) : null
  const reads = [...months].map(month => {
    return { month, ...preparePaymentPerformance(organization, Number(month.slice(0, 4)), month, { sql: readsPayouts }) }
  })
  return {
    queries: [...reads.flatMap(plan => plan.queries), ...(payout ? [payout] : [])].map(query => withViewer(membership, query)),
    apply(event: H3Event, rows: D1Result[], organization: { slug: string; id: string }) {
      let offset = 0
      const periods = new Map(reads.map(plan => {
        const values = rows.slice(offset, offset + plan.queries.length)
        offset += plan.queries.length
        return [plan.month, plan.read(values, organization.id)]
      }))
      if (payout) event.context.dashboardPayoutAccount = { organizationId: organization.id, account: stripeConnectedAccountFromRow(rows[offset]?.results[0]) }
      event.context.dashboardEarnings = { slug: organization.slug, periods }
    },
  }
}

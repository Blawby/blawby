import { HTTPError, type H3Event } from 'nitro'
import { getQuery } from 'nitro/h3'
import { cloudflareEnv } from '~/server/utils/api-response'
import { staffAccessWritesEnabled } from '~/server/domain/listing-access'
import { parseTaskListQuery } from '~/server/domain/tasks'
import { prepareToday } from '~/server/domain/today'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'
import { dashboardOrgQueryParam, getDashboardSession } from '~/server/utils/dashboard-context'
import { oncePerRequest } from '~/server/utils/request-scope'
import { executeBatch, type BatchQuery } from '~/server/db'
import { membershipBySlugQuery } from '~/server/utils/member-access'
import { dashboardSessionUserQuery, type DashboardAuthRead } from '~/server/utils/auth'

export function readDashboardTodayDocument(event: H3Event, orgSlug: string, preloaded?: () => ReturnType<ReturnType<typeof prepareToday>['read']>) {
  return oncePerRequest(event, `dashboard-today:${orgSlug}`, async () => {
    if (!preloaded) return readDashboardToday(event, orgSlug)
    return finalizeRequestMetrics(event, 'dashboard-today', await preloaded())
  })
}

/**
 * Today and Upcoming for the person looking, one list (server/domain/today.ts).
 * Read the membership by the route's slug and the rows for the cards in one batch.
 */
export async function readDashboardToday(event: H3Event, orgSlug?: string) {
  const env = cloudflareEnv(event)
  const slug = orgSlug ?? dashboardOrgQueryParam(event)
  if (!slug) throw new HTTPError({ statusCode: 400, message: 'Organization context is required. Use /dashboard/{orgSlug} routes.', data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
  const query = getQuery(event)
  const range = query.range ?? 'today'
  if (range !== 'today' && range !== 'upcoming') throw new HTTPError({ statusCode: 400, message: 'range must be today or upcoming', data: { code: 'INVALID_TODAY_QUERY', field: 'range' } })
  // Installed iOS clients use Better Auth bearer sessions and share this URL.
  const native = /^Bearer\s/i.test(event.req.headers.get('authorization') ?? '')
    ? { env, event, query: parseTaskListQuery(query, { range }) } : undefined
  const now = new Date()
  const prepare = (user: string | BatchQuery) => prepareToday({ slug, membership: membershipBySlugQuery(slug, user), range, now,
    staffAccessWrites: staffAccessWritesEnabled(env), native, presentation: { env, event } })
  let plan: ReturnType<typeof prepare> | undefined
  const auth: DashboardAuthRead = { queries(token) { plan = prepare(dashboardSessionUserQuery(token)); return plan.queries } }
  const session = await getDashboardSession(event, env, auth)
  if (!session?.user?.id) throw new HTTPError({ statusCode: 401, message: 'Authentication required', data: { code: 'UNAUTHORIZED', field: 'session' } })
  plan ??= prepare(session.user.id)
  const today = await plan.read(auth.results ?? await executeBatch(env.DB, plan.queries, { operation: 'Read Today' }))
  return finalizeRequestMetrics(event, 'dashboard-today', today)
}

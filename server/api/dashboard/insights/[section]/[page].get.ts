import { defineHandler, HTTPError } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { dashboardOrgQueryParam, getDashboardMemberContext, readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { insightsReader, prepareStoredInsightsPage, readInsightsPage } from '~/server/domain/insights'
import { insightsPage } from '~/shared/insights'

export default defineHandler(async (event) => {
  const query = getQuery(event)
  const value = (name: string) => {
    if (query[name] === undefined) return undefined
    if (typeof query[name] !== 'string') throw new HTTPError({ statusCode: 400, message: `${name} must be a string`, data: { code: 'INVALID_FILTER', field: name } })
    return query[name] as string
  }
  const pageId = `${getRouterParam(event, 'section')}/${getRouterParam(event, 'page')}`
  const filters = { kind: value('kind'), location_id: value('location_id'), start_date: value('start_date'), end_date: value('end_date') }
  const env = cloudflareEnv(event)
  if (insightsPage(pageId)?.section !== 'marketing') {
    const slug = dashboardOrgQueryParam(event)
    if (!slug) throw new HTTPError({ statusCode: 400, message: 'Organization is required', data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
    const plan = prepareStoredInsightsPage(env.DB, pageId, filters)
    const { userId, organization, rows } = await readDashboardMemberResources(event, { slug }, plan.queries)
    return jsonResponse(plan.read(await insightsReader(organization, userId), rows), { headers: { 'cache-control': 'private, no-store' } })
  }
  const { db, userId, organization } = await getDashboardMemberContext(event, {})
  return jsonResponse(await readInsightsPage(db, await insightsReader(organization, userId), pageId, filters, env), { headers: { 'cache-control': 'private, no-store' } })
})

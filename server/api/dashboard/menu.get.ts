import { getQuery } from 'nitro/h3'
import { defineHandler, HTTPError } from 'nitro'
import { dashboardOrgQueryParam, readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { prepareDashboardMenu } from '~/server/utils/dashboard-menu'
import { jsonResponse } from '~/server/utils/api-response'

export default defineHandler(async event => {
  const slug = dashboardOrgQueryParam(event)
  if (!slug) throw new HTTPError({ statusCode: 400, message: 'Organization is required', data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
  const plan = prepareDashboardMenu(getQuery(event).native === '1')
  const { organization, userId, rows, env, session } = await readDashboardMemberResources(event, { slug }, plan.queries)
  if (!env.BETTER_AUTH_URL) throw new HTTPError({ statusCode: 500, message: 'Application origin is not configured', data: { code: 'INVALID_MENU_CONTEXT', field: 'BETTER_AUTH_URL' } })
  return jsonResponse(await plan.read(organization, userId, rows, { origin: env.BETTER_AUTH_URL, impersonated: Boolean((session.session as { impersonatedBy?: string }).impersonatedBy) }), { headers: { 'cache-control': 'private, no-store' } })
})

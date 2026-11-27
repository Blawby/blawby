import { defineHandler, HTTPError } from 'nitro'
import { dashboardOrgQueryParam, readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { prepareDashboardMenu } from '~/server/utils/dashboard-menu'
import { jsonResponse } from '~/server/utils/api-response'

export default defineHandler(async event => {
  const slug = dashboardOrgQueryParam(event)
  if (!slug) throw new HTTPError({ statusCode: 400, message: 'Organization is required', data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
  const plan = prepareDashboardMenu()
  const { organization, userId, rows } = await readDashboardMemberResources(event, { slug }, plan.queries)
  return jsonResponse(await plan.read(organization, userId, rows), { headers: { 'cache-control': 'private, no-store' } })
})

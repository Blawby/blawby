import { defineHandler, HTTPError } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { dashboardOrgQueryParam, readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { insightsReader, prepareInsightsIndex } from '~/server/domain/insights'

export default defineHandler(async (event) => {
  const slug = dashboardOrgQueryParam(event)
  if (!slug) throw new HTTPError({ statusCode: 400, message: 'Organization is required', data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
  const plan = prepareInsightsIndex()
  const { userId, organization, rows } = await readDashboardMemberResources(event, { slug }, plan.queries)
  return jsonResponse(plan.read(await insightsReader(organization, userId), rows), { headers: { 'cache-control': 'private, no-store' } })
})

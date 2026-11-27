import { defineHandler, HTTPError } from 'nitro'
import { getQuery } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { dashboardOrgQueryParam, readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { insightsReader, prepareInsightsOverview } from '~/server/domain/insights'
import { roleAllows } from '~/server/utils/member-access'

export default defineHandler(async (event) => {
  const slug = dashboardOrgQueryParam(event)
  if (!slug) throw new HTTPError({ statusCode: 400, message: 'Organization is required', data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
  const query = getQuery(event)
  if (query.days !== undefined && typeof query.days !== 'string') throw new HTTPError({ statusCode: 400, message: 'days must be 7, 30 or 365', data: { code: 'INVALID_FILTER', field: 'days' } })
  const env = cloudflareEnv(event)
  const plan = prepareInsightsOverview(env.DB, query.days as string | undefined)
  const { userId, organization, rows } = await readDashboardMemberResources(event, { slug }, plan.queries)
  const reader = await insightsReader(organization, userId)
  const suggestions = await roleAllows({ organizationId: organization.id, role: organization.role, permissions: { task: ['assign'] } })
  return jsonResponse(plan.read(reader, suggestions, rows), { headers: { 'cache-control': 'private, no-store' } })
})

import { defineHandler, HTTPError } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { dashboardOrgQueryParam, readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { prepareStayHomeDocument, stayAccessFor } from '~/server/domain/stays'
import { STAY_HOME_VOCABULARY } from '~/shared/stay-listing'

export default defineHandler(async event => {
  const productId = getRouterParam(event, 'product_id')
  const slug = dashboardOrgQueryParam(event)
  const view = getQuery(event).view
  if (view !== undefined && view !== 'editor') throw new HTTPError({ statusCode: 400, message: 'Choose a valid home view', data: { code: 'INVALID_QUERY', field: 'view' } })
  if (!productId || !slug) throw new HTTPError({ statusCode: 400, message: 'A workspace and product are required' })
  const plan = prepareStayHomeDocument(productId)
  const { env, organization, rows } = await readDashboardMemberResources(event, { slug }, plan.queries)
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  return jsonResponse({ home: plan.read(rows), manage: access.manage, ...(view === 'editor' ? { vocabulary: STAY_HOME_VOCABULARY } : {}) }, { headers: { 'cache-control': 'private, no-store' } })
})

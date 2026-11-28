import { jsonResponse, rethrowHttpError } from '~/server/utils/api-response'
import { loadDashboardProduct } from '~/server/utils/dashboard-editor-resources'
import { defineHandler, HTTPError } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const productId = getRouterParam(event, 'product_id')
  if (!organizationId || !productId) return jsonResponse({ error: 'Organization and Product IDs are required' }, { status: 400 })
  try {
    const query = getQuery(event)
    if (query.location_id !== undefined && (typeof query.location_id !== 'string' || !query.location_id.trim())) {
      throw new HTTPError({ statusCode: 400, message: 'Choose a valid location', data: { code: 'INVALID_PRODUCT_SCOPE', field: 'location_id' } })
    }
    let calendar
    if (query.from !== undefined || query.to !== undefined) {
      if (typeof query.from !== 'string' || typeof query.to !== 'string' || !Number.isFinite(Date.parse(query.from)) || !Number.isFinite(Date.parse(query.to)) || Date.parse(query.to) <= Date.parse(query.from)) {
        throw new HTTPError({ statusCode: 400, message: 'Choose valid instants with to after from', data: { code: 'INVALID_SESSION_WINDOW', field: 'from,to' } })
      }
      calendar = { fromInstant: new Date(query.from).toISOString(), toInstant: new Date(query.to).toISOString(), scope: 'editor' as const, now: new Date().toISOString() }
    }
    return jsonResponse(await loadDashboardProduct(event, organizationId, query.location_id as string | undefined ?? null, productId, query.editor === '1', calendar, query.include === 'agreement_template'), { headers: { 'cache-control': 'private, no-store' } })
  } catch (error) {
    rethrowHttpError(error)
    return jsonResponse({ error: 'Failed to load Product' }, { status: 500 })
  }
})

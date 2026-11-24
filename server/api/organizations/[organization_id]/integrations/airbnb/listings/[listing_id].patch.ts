import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { ChannexConnection } from '~/server/integrations/channex/channel-connection'

// A listing's price against its home's: {price_adjustment_type: 'percent' | 'amount' | null, price_adjustment: signed whole number | null}.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const listingId = getRouterParam(event, 'listing_id')
  if (!organizationId || !listingId) return jsonResponse({ error: 'Organization and listing IDs are required', code: 'VALIDATION_ERROR', field: 'params' }, { status: 400 })
  const { env, session, organization } = await requireOrganizationAccess(event, organizationId)
  const body = await readBody<{ price_adjustment_type?: unknown; price_adjustment?: unknown }>(event)
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'price_adjustment_type' && key !== 'price_adjustment')) {
    return jsonResponse({ error: 'Send {price_adjustment_type, price_adjustment}', code: 'VALIDATION_ERROR', field: 'body' }, { status: 400 })
  }
  return jsonResponse(await new ChannexConnection(env.DB, env, organization.id, session.user.id).setListingPrice(listingId, body))
})

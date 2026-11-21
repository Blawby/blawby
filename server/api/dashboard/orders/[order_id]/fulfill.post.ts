import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { requireRequestedOrganizationWideAccess } from '~/server/utils/location-access'
import { fulfillOrder } from '~/server/domain/goods'

/** Marks the order shipped (carrier, tracking) or collected; the buyer is told. */
export default defineHandler(async event => {
  const { env, db, session, organization } = await requireRequestedOrganizationWideAccess(event)
  const body = await readRequiredBody<Record<string, unknown>>(event)
  return jsonResponse({ order: await fulfillOrder(db, env, { organizationId: organization.id, orderId: getRouterParam(event, 'order_id')!, actorId: session.user.id,
    carrier: body.carrier, tracking_number: body.tracking_number, tracking_url: body.tracking_url }) })
})

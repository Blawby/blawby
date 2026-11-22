import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireRequestedOrganizationWideAccess } from '~/server/utils/location-access'
import { deleteShippingZone } from '~/server/domain/goods'

export default defineHandler(async event => {
  const { db, organization } = await requireRequestedOrganizationWideAccess(event)
  await deleteShippingZone(db, organization.id, getRouterParam(event, 'zone_id')!)
  return jsonResponse({ success: true })
})

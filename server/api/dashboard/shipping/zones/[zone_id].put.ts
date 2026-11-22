import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { requireRequestedOrganizationWideAccess } from '~/server/utils/location-access'
import { saveShippingZone } from '~/server/domain/goods'

export default defineHandler(async event => {
  const { db, organization } = await requireRequestedOrganizationWideAccess(event)
  return jsonResponse({ zone: await saveShippingZone(db, organization.id, getRouterParam(event, 'zone_id')!, await readRequiredBody(event)) })
})

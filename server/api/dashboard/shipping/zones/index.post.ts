import { defineHandler } from 'nitro'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { requireRequestedOrganizationWideAccess } from '~/server/utils/location-access'
import { saveShippingZone } from '~/server/domain/goods'

export default defineHandler(async event => {
  const { db, organization } = await requireRequestedOrganizationWideAccess(event)
  return jsonResponse({ zone: await saveShippingZone(db, organization.id, null, await readRequiredBody(event)) }, { status: 201 })
})

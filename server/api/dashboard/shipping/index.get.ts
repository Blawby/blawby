import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { requireRequestedOrganizationWideAccess } from '~/server/utils/location-access'
import { readShippingSettings } from '~/server/domain/goods'

/** Where the business ships from and to, and where buyers can collect. */
export default defineHandler(async event => {
  const { db, organization } = await requireRequestedOrganizationWideAccess(event)
  return jsonResponse(await readShippingSettings(db, organization.id))
})

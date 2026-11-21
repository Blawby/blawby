import { defineHandler } from 'nitro'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { requireRequestedOrganizationWideAccess } from '~/server/utils/location-access'
import { setLocationPickup } from '~/server/domain/goods'

export default defineHandler(async event => {
  const { db, organization } = await requireRequestedOrganizationWideAccess(event)
  const body = await readRequiredBody<{ location_id?: unknown; pickup_enabled?: unknown }>(event)
  if (typeof body.location_id !== 'string') return jsonResponse({ error: 'location_id is required', code: 'VALIDATION_ERROR', field: 'location_id' }, { status: 400 })
  await setLocationPickup(db, organization.id, body.location_id, body.pickup_enabled as boolean)
  return jsonResponse({ success: true })
})
